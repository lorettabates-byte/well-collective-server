import { Router } from "express";
import { pool } from "../db";
import { todayInTimezone, addDays, SQL_DAY_START, SQL_MONTH_START, SQL_YEAR_START, sqlSameDay, TIMEZONE } from "../dateUtils";
import { isAnthropicConfigured, parseMealDescriptionForNutritionLookup } from "../anthropic";
import { isUsdaConfigured, computeNutritionFromIngredients } from "../usda";
import { requireAdmin } from "../middleware/adminAuth";
import { sendNotificationToUser } from "../push";

const router = Router();

// Returns the member's stored IANA timezone, falling back to the server default.
async function getMemberTimezone(memberEmail: string): Promise<string> {
  try {
    const { rows } = await pool.query(
      "SELECT timezone FROM members WHERE email = $1",
      [memberEmail]
    );
    return rows[0]?.timezone || TIMEZONE;
  } catch {
    return TIMEZONE;
  }
}

// Builds SQL expressions in an arbitrary IANA timezone.
// Sanitized to only allow valid IANA characters (letters, digits, /, _, +, -).
function sanitizeTimezone(tz: string): string {
  const safe = tz.replace(/[^A-Za-z0-9/_+\-]/g, "");
  return safe || TIMEZONE;
}

function sqlDayStartFor(tz: string): string {
  const safe = sanitizeTimezone(tz);
  return `date_trunc('day', now() AT TIME ZONE '${safe}') AT TIME ZONE '${safe}'`;
}

function sqlLocalDateFor(column: string, tz: string): string {
  const safe = sanitizeTimezone(tz);
  return `(${column} AT TIME ZONE '${safe}')::date`;
}

// Milestone bonuses shown in the streak modal — kept as a single source of
// truth so the popup and the actual point award never drift apart.
export const STREAK_MILESTONES = [
  { days: 2, bonus: 10 },
  { days: 7, bonus: 20 },
  { days: 14, bonus: 40 },
  { days: 30, bonus: 80 },
] as const;

function streakBonusPoints(streak: number): number {
  // Only awarded on the exact day a milestone is hit, not every day after —
  // a member logging in on day 8 shouldn't re-earn the day-7 bonus.
  const hit = STREAK_MILESTONES.find((m) => m.days === streak);
  return hit ? hit.bonus : 0;
}

async function updateLoginStreak(
  email: string
): Promise<{ streak: number; bonus: number; longestStreak: number }> {
  const { rows } = await pool.query(
    `SELECT current_streak, last_login_date::text AS last_login_date, longest_streak
     FROM login_streaks WHERE member_email = $1`,
    [email]
  );

  const todayStr = todayInTimezone();

  let currentStreak = 1;
  let longestStreak = 1;

  if (rows.length > 0) {
    const { current_streak, last_login_date, longest_streak } = rows[0];
    const lastDate: string = last_login_date.slice(0, 10);

    if (lastDate === todayStr) {
      // Already processed today — return without awarding bonus again
      return { streak: current_streak, bonus: 0, longestStreak: longest_streak };
    }

    const yesterdayStr = addDays(todayStr, -1);
    currentStreak = lastDate === yesterdayStr ? current_streak + 1 : 1;
    longestStreak = Math.max(currentStreak, longest_streak);
  }

  await pool.query(
    `INSERT INTO login_streaks (member_email, current_streak, last_login_date, longest_streak, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (member_email) DO UPDATE SET
       current_streak = $2,
       last_login_date = $3,
       longest_streak = $4,
       updated_at = now()`,
    [email, currentStreak, todayStr, longestStreak]
  );

  const bonus = streakBonusPoints(currentStreak);

  if (bonus > 0) {
    await pool.query(
      `INSERT INTO activity_logs (member_email, activity_type, points, metadata)
       VALUES ($1, 'login_streak_bonus', $2, $3)`,
      [email, bonus, JSON.stringify({ streak: currentStreak })]
    );
  }

  return { streak: currentStreak, bonus, longestStreak };
}

export const POINT_VALUES: Record<string, number> = {
  app_open: 5,
  forum_post: 10,
  forum_comment: 5,
  class_watch: 20,
  song_play: 5,
  blog_open: 5,
  meal_log: 10,
  sleep_log: 10,
  breathwork: 15,
  breathwork_extended: 20,
  breathwork_calm_kit: 10,
  stretching: 15,
  resistance_training: 20,
  well_activity: 15,
  event_attend: 25,
  well_escape: 100,
  tribe_add: 5,
  tribe_challenge_complete: 25,
  cardio: 20,
  daily_challenge_accept: 10,
  tutorial_complete: 50,
  notifications_enabled: 20,
  add_to_homescreen: 25,
  login_streak_bonus: 0, // variable — awarded directly in updateLoginStreak
};

// Max times a given activity type can earn points in one calendar day (member-facing timezone) per member.
const DAILY_CAPS: Record<string, number> = {
  app_open: 1,
  blog_open: 2,
  sleep_log: 1,
  song_play: 5,
  class_watch: 1,
  meal_log: 4,
  tribe_add: 5,
  cardio: 1,
  daily_challenge_accept: 3,
  tutorial_complete: 1,
  notifications_enabled: 1,
  add_to_homescreen: 1,
  breathwork: 1,
  breathwork_extended: 1,
  breathwork_calm_kit: 1,
  stretching: 1,
  resistance_training: 1,
  well_activity: 1,
};

const HISTORY_ACTIVITY_MET: Record<string, { met: number; minutes: number }> = {
  resistance_training: { met: 5.0, minutes: 40 },
  cardio: { met: 7.0, minutes: 30 },
  class_watch: { met: 6.5, minutes: 40 },
  breathwork: { met: 1.3, minutes: 10 },
  breathwork_extended: { met: 1.3, minutes: 20 },
  breathwork_calm_kit: { met: 1.3, minutes: 10 },
  stretching: { met: 2.3, minutes: 15 },
  well_activity: { met: 2.8, minutes: 20 },
};

const HISTORY_KCAL_PER_STEP_PER_KG = 0.00057;

const HISTORY_CHECKIN_GRID = [
  ["resistance_training", "cardio"],
  ["sleep_log"],
  ["meal_log"],
  ["breathwork", "breathwork_extended", "breathwork_calm_kit"],
  ["stretching"],
  ["class_watch", "blog_open", "well_activity"],
];

function roundMetric(value: number, places = 0): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function averageMetric(values: number[], places = 0): number | null {
  const filtered = values.filter((value) => Number.isFinite(value) && value > 0);
  if (filtered.length === 0) return null;
  return roundMetric(filtered.reduce((sum, value) => sum + value, 0) / filtered.length, places);
}

function coveredWellAreas(activities: { type: string }[]): number {
  const types = new Set(activities.map((activity) => activity.type));
  return HISTORY_CHECKIN_GRID.filter((group) => group.some((type) => types.has(type))).length;
}

function estimateEnergyOut(
  activities: { type: string; count: number }[],
  steps: number,
  member: { height_cm: unknown; weight_kg: unknown; age: unknown; gender: unknown } | null
): number | null {
  if (!member?.height_cm || !member?.weight_kg || !member?.age) return null;

  const heightCm = Number(member.height_cm);
  const weightKg = Number(member.weight_kg);
  const age = Number(member.age);
  if (!Number.isFinite(heightCm) || !Number.isFinite(weightKg) || !Number.isFinite(age)) return null;

  const base = (10 * weightKg) + (6.25 * heightCm) - (5 * age);
  const gender = String(member.gender ?? "").toLowerCase();
  const bmr = gender === "male" ? base + 5 : gender === "female" ? base - 161 : base - 78;
  const baselineCalories = bmr * 1.2;
  const exerciseCalories = activities.reduce((sum, activity) => {
    const def = HISTORY_ACTIVITY_MET[activity.type];
    if (!def) return sum;
    return sum + ((def.met * 3.5 * weightKg) / 200) * def.minutes * activity.count;
  }, 0);
  const stepCalories = steps * weightKg * HISTORY_KCAL_PER_STEP_PER_KG;

  return Math.max(0, Math.round(baselineCalories + exerciseCalories + stepCalories));
}

/**
 * Award points to a member for an activity. Enforces daily caps silently.
 * Safe to fire-and-forget — errors are logged but not propagated.
 */
export async function awardPoints(
  memberEmail: string,
  activityType: string,
  metadata?: Record<string, unknown>
): Promise<{ awarded: boolean; points: number }> {
  const points = POINT_VALUES[activityType];
  if (!points) return { awarded: false, points: 0 };

  const cap = DAILY_CAPS[activityType];
  if (cap !== undefined) {
    // Use the member's own timezone so their "day" matches their local clock,
    // not the server's Eastern timezone.
    const memberTz = await getMemberTimezone(memberEmail);
    const dayStart = sqlDayStartFor(memberTz);
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count FROM activity_logs
       WHERE member_email = $1 AND activity_type = $2
         AND created_at >= ${dayStart}`,
      [memberEmail, activityType]
    );
    if (Number(rows[0].count) >= cap) return { awarded: false, points: 0 };
  }

  await pool.query(
    `INSERT INTO activity_logs (member_email, activity_type, points, metadata)
     VALUES ($1, $2, $3, $4)`,
    [memberEmail, activityType, points, metadata ? JSON.stringify(metadata) : null]
  );

  return { awarded: true, points };
}

// Removes the most recent today's activity log entry for the given type (undo accidental check-in).
router.delete("/activity", async (req, res) => {
  const { memberEmail, type } = req.body as { memberEmail?: string; type?: string };
  if (!memberEmail || !type) {
    return res.status(400).json({ error: "memberEmail and type required" });
  }
  if (!POINT_VALUES[type]) {
    return res.status(400).json({ error: "Unknown activity type" });
  }
  try {
    const memberTz = await getMemberTimezone(memberEmail.toLowerCase());
    const dayStart = sqlDayStartFor(memberTz);
    await pool.query(
      `DELETE FROM activity_logs
       WHERE id = (
         SELECT id FROM activity_logs
         WHERE member_email = $1 AND activity_type = $2
           AND created_at >= ${dayStart}
         ORDER BY created_at DESC
         LIMIT 1
       )`,
      [memberEmail.toLowerCase(), type]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Unlog activity error:", err);
    res.status(500).json({ error: "Failed to unlog activity" });
  }
});

// Client calls this for activities that happen in the browser:
// app_open, song_play, blog_open, class_watch, breathwork, stretching,
// resistance_training, sleep_log, well_activity, event_attend, well_escape.
router.post("/activity", async (req, res) => {
  const { memberEmail, type, metadata } = req.body as {
    memberEmail?: string;
    type?: string;
    metadata?: Record<string, unknown>;
  };

  if (!memberEmail || !type) {
    return res.status(400).json({ error: "memberEmail and type required" });
  }
  if (!POINT_VALUES[type]) {
    return res.status(400).json({ error: "Unknown activity type" });
  }

  // Silently ignore if the email doesn't exist in members yet (guest/anonymous).
  const { rows: memberRows } = await pool.query(
    "SELECT email FROM members WHERE email = $1",
    [memberEmail.toLowerCase()]
  );
  if (memberRows.length === 0) return res.json({ awarded: false, points: 0 });

  try {
    const email = memberEmail.toLowerCase();
    const result = await awardPoints(email, type, metadata);

    let streakData: { streak: number; bonus: number; longestStreak: number } | null = null;
    if (result.awarded && type === "app_open") {
      streakData = await updateLoginStreak(email).catch(() => null);
    }

    res.json({ ...result, streak: streakData });
  } catch (err) {
    console.error("Log activity error:", err);
    res.status(500).json({ error: "Failed to log activity" });
  }
});

// Today's leaderboard — members visible on the board, ordered by points earned
// today in the member-facing timezone (America/New_York by default).
// ?limit=N caps the result (default 10). Pass limit=all for the full list.
router.get("/leaderboard", async (req, res) => {
  const limitParam = (req.query.limit as string | undefined) ?? "10";
  const limitClause = limitParam === "all" ? "" : `LIMIT ${Math.min(parseInt(limitParam) || 10, 500)}`;

  try {
    const { rows } = await pool.query(`
      SELECT
        m.email,
        m.name,
        m.avatar,
        COALESCE(SUM(al.points), 0) AS total_points
      FROM members m
      JOIN activity_logs al ON al.member_email = m.email
        AND al.created_at >= ${SQL_DAY_START}
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.avatar
      ORDER BY total_points DESC
      ${limitClause}
    `);

    const { rows: resetRows } = await pool.query(`SELECT (${SQL_DAY_START} + INTERVAL '1 day') AS reset_at`);

    res.json({
      leaderboard: rows.map((r) => ({
        email: r.email,
        name: r.name,
        avatar: r.avatar ?? null,
        points: Number(r.total_points),
      })),
      resetAt: new Date(resetRows[0].reset_at).toISOString(),
    });
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// Monthly leader — member with most points in the current month (member-facing timezone).
router.get("/leaderboard/monthly", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.email, m.name, m.avatar, COALESCE(SUM(al.points), 0) AS total_points
      FROM members m
      JOIN activity_logs al ON al.member_email = m.email
        AND al.created_at >= ${SQL_MONTH_START}
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.avatar
      ORDER BY total_points DESC
      LIMIT 1
    `);
    res.json({ leader: rows[0] ? { name: rows[0].name, avatar: rows[0].avatar ?? null, total_points: Number(rows[0].total_points) } : null });
  } catch (err) {
    console.error("Monthly leader error:", err);
    res.status(500).json({ error: "Failed to fetch monthly leader" });
  }
});

// Yearly leader — member with most points in the current year (member-facing timezone).
router.get("/leaderboard/yearly", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.email, m.name, m.avatar, COALESCE(SUM(al.points), 0) AS total_points
      FROM members m
      JOIN activity_logs al ON al.member_email = m.email
        AND al.created_at >= ${SQL_YEAR_START}
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.avatar
      ORDER BY total_points DESC
      LIMIT 1
    `);
    // Compute next Jan 1 midnight in the server timezone so the client can
    // show a countdown to the yearly reset.
    const { rows: resetRows } = await pool.query(
      `SELECT date_trunc('year', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}' + INTERVAL '1 year' AS year_reset_at`
    );
    res.json({
      leader: rows[0] ? { name: rows[0].name, avatar: rows[0].avatar ?? null, total_points: Number(rows[0].total_points) } : null,
      yearResetAt: new Date(resetRows[0].year_reset_at).toISOString(),
    });
  } catch (err) {
    console.error("Yearly leader error:", err);
    res.status(500).json({ error: "Failed to fetch yearly leader" });
  }
});

// Yesterday's WELL CUP winner (awarded by the midnight-ET cron job).
router.get("/leaderboard/yesterday", async (_req, res) => {
  try {
    const yesterday = addDays(todayInTimezone(), -1);
    const { rows } = await pool.query(
      `SELECT w.win_date, w.total_points, m.name, m.avatar, m.email
       FROM well_cup_wins w
       JOIN members m ON m.email = w.member_email
       WHERE w.win_date = $1`,
      [yesterday]
    );
    res.json({ winner: rows[0] ?? null });
  } catch (err) {
    console.error("Yesterday winner error:", err);
    res.status(500).json({ error: "Failed to fetch yesterday's winner" });
  }
});

// A member's own activity breakdown for today (for the Well Check).
router.get("/activity/today", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(`
      SELECT activity_type, SUM(points) AS points, COUNT(*) AS count
      FROM activity_logs
      WHERE member_email = $1
        AND created_at >= ${SQL_DAY_START}
      GROUP BY activity_type
    `, [email.toLowerCase()]);

    const totalPoints = rows.reduce((sum, r) => sum + Number(r.points), 0);
    res.json({
      activities: rows.map((r) => ({
        type: r.activity_type,
        points: Number(r.points),
        count: Number(r.count),
      })),
      totalPoints,
    });
  } catch (err) {
    console.error("Today activity error:", err);
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

// A member's recent WELL Check history, grouped by their local calendar day.
router.get("/activity/history", async (req, res) => {
  const { email, range } = req.query as { email?: string; range?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  const selectedRange = range === "month" || range === "year" ? range : "week";
  const daysBack = selectedRange === "year" ? 365 : selectedRange === "month" ? 30 : 7;
  const memberEmail = email.toLowerCase();

  try {
    const memberTz = await getMemberTimezone(memberEmail);
    const activityLocalDate = sqlLocalDateFor("created_at", memberTz);
    const loggedAtLocalDate = sqlLocalDateFor("logged_at", memberTz);
    const dayStart = sqlDayStartFor(memberTz);

    const [activityResult, mealResult, sleepResult, stepResult, memberResult] = await Promise.all([
      pool.query(
        `WITH scoped AS (
           SELECT ${activityLocalDate} AS log_date, activity_type, points
           FROM activity_logs
           WHERE member_email = $1
             AND created_at >= (${dayStart} - (($2::int - 1) * INTERVAL '1 day'))
         )
         SELECT log_date::text AS date, activity_type, SUM(points)::int AS points, COUNT(*)::int AS count
         FROM scoped
         GROUP BY log_date, activity_type
         ORDER BY log_date DESC, activity_type ASC`,
        [memberEmail, daysBack]
      ),
      pool.query(
        `WITH scoped AS (
           SELECT ${loggedAtLocalDate} AS log_date,
                  estimated_calories,
                  estimated_protein_g,
                  estimated_carbs_g,
                  estimated_fat_g
           FROM meal_entries
           WHERE member_email = $1
             AND logged_at >= (${dayStart} - (($2::int - 1) * INTERVAL '1 day'))
         )
         SELECT log_date::text AS date,
                COALESCE(SUM(estimated_calories), 0)::int AS energy_in,
                COALESCE(SUM(estimated_protein_g), 0)::float AS protein,
                COALESCE(SUM(estimated_carbs_g), 0)::float AS carbs,
                COALESCE(SUM(estimated_fat_g), 0)::float AS fat
         FROM scoped
         GROUP BY log_date
         ORDER BY log_date DESC`,
        [memberEmail, daysBack]
      ),
      pool.query(
        `WITH scoped AS (
           SELECT ${loggedAtLocalDate} AS log_date, hours
           FROM sleep_entries
           WHERE member_email = $1
             AND logged_at >= (${dayStart} - (($2::int - 1) * INTERVAL '1 day'))
         )
         SELECT log_date::text AS date, AVG(hours)::float AS sleep_hours
         FROM scoped
         GROUP BY log_date
         ORDER BY log_date DESC`,
        [memberEmail, daysBack]
      ),
      pool.query(
        `WITH scoped AS (
           SELECT ${loggedAtLocalDate} AS log_date, steps, logged_at
           FROM step_entries
           WHERE member_email = $1
             AND logged_at >= (${dayStart} - (($2::int - 1) * INTERVAL '1 day'))
         )
         SELECT DISTINCT ON (log_date) log_date::text AS date, steps::int AS steps
         FROM scoped
         ORDER BY log_date DESC, logged_at DESC`,
        [memberEmail, daysBack]
      ),
      pool.query(
        "SELECT height_cm, weight_kg, age, gender FROM members WHERE email = $1",
        [memberEmail]
      ),
    ]);

    type HistoryDay = {
      date: string;
      totalPoints: number;
      activities: { type: string; points: number; count: number }[];
      energyIn: number;
      energyOut: number | null;
      sleepHours: number | null;
      steps: number;
      protein: number;
      carbs: number;
      fat: number;
      wellAreas: number;
    };

    const days = new Map<string, HistoryDay>();
    const activityTotals = new Map<string, { type: string; points: number; count: number }>();
    let totalPoints = 0;

    const ensureDay = (dateValue: unknown): HistoryDay => {
      const date = String(dateValue).slice(0, 10);
      if (!days.has(date)) {
        days.set(date, {
          date,
          totalPoints: 0,
          activities: [],
          energyIn: 0,
          energyOut: null,
          sleepHours: null,
          steps: 0,
          protein: 0,
          carbs: 0,
          fat: 0,
          wellAreas: 0,
        });
      }
      return days.get(date)!;
    };

    for (const row of activityResult.rows) {
      const date = String(row.date).slice(0, 10);
      const points = Number(row.points);
      const count = Number(row.count);
      const type = String(row.activity_type);

      const day = ensureDay(date);
      day.activities.push({ type, points, count });
      day.totalPoints += points;

      const total = activityTotals.get(type) ?? { type, points: 0, count: 0 };
      total.points += points;
      total.count += count;
      activityTotals.set(type, total);
      totalPoints += points;
    }

    for (const row of mealResult.rows) {
      const day = ensureDay(row.date);
      day.energyIn = Number(row.energy_in) || 0;
      day.protein = roundMetric(Number(row.protein) || 0, 1);
      day.carbs = roundMetric(Number(row.carbs) || 0, 1);
      day.fat = roundMetric(Number(row.fat) || 0, 1);
    }

    for (const row of sleepResult.rows) {
      const day = ensureDay(row.date);
      day.sleepHours = row.sleep_hours == null ? null : roundMetric(Number(row.sleep_hours), 1);
    }

    for (const row of stepResult.rows) {
      const day = ensureDay(row.date);
      day.steps = Number(row.steps) || 0;
    }

    const member = memberResult.rows[0] ?? null;
    for (const day of days.values()) {
      day.activities.sort((a, b) => b.points - a.points);
      day.wellAreas = coveredWellAreas(day.activities);
      day.energyOut = estimateEnergyOut(day.activities, day.steps, member);
    }

    const orderedDays = Array.from(days.values()).sort((a, b) => b.date.localeCompare(a.date));

    res.json({
      range: selectedRange,
      days: orderedDays,
      totals: {
        totalPoints,
        completedDays: days.size,
        activityCounts: Array.from(activityTotals.values()).sort((a, b) => b.points - a.points),
        averages: {
          sleepHours: averageMetric(orderedDays.map((day) => day.sleepHours ?? 0), 1),
          energyIn: averageMetric(orderedDays.map((day) => day.energyIn)),
          energyOut: averageMetric(orderedDays.map((day) => day.energyOut ?? 0)),
          steps: averageMetric(orderedDays.map((day) => day.steps)),
          wellAreas: averageMetric(orderedDays.map((day) => day.wellAreas), 1),
        },
      },
    });
  } catch (err) {
    console.error("Activity history error:", err);
    res.status(500).json({ error: "Failed to fetch activity history" });
  }
});

// Estimate calories + macros for a freeform meal description. Uses the same
// approach as AI-generated recipes: Claude breaks the description into food
// items + gram estimates, then real nutrition values come from USDA
// FoodData Central (not an LLM guess) via computeNutritionFromIngredients.
router.post("/meals/estimate", async (req, res) => {
  const { description } = req.body as { description?: string };
  if (!description || !description.trim()) {
    return res.status(400).json({ error: "description required" });
  }
  if (!isAnthropicConfigured() || !isUsdaConfigured()) {
    return res.status(503).json({ error: "Calorie estimator is not configured" });
  }

  try {
    const parsed = await parseMealDescriptionForNutritionLookup(description.trim());

    // Per-item lookups (sequential — see the FDC flakiness note in usda.ts)
    // so "eggs, ham, and orange juice" comes back as three editable rows on
    // the client instead of one opaque combined total.
    const items: { label: string; calories: number; protein: number; carbs: number; fat: number; verified: boolean }[] = [];
    for (const item of parsed) {
      const nutrition = await computeNutritionFromIngredients([item]);
      if (!nutrition) continue;
      items.push({
        label: item.label,
        calories: nutrition.calories,
        protein: parseInt(nutrition.protein, 10) || 0,
        carbs: parseInt(nutrition.carbs, 10) || 0,
        fat: parseInt(nutrition.fat, 10) || 0,
        verified: nutrition.verified,
      });
    }
    if (items.length === 0) {
      return res.status(422).json({ error: "Couldn't estimate nutrition for that description" });
    }

    const totals = items.reduce(
      (sum, i) => ({
        calories: sum.calories + i.calories,
        protein: sum.protein + i.protein,
        carbs: sum.carbs + i.carbs,
        fat: sum.fat + i.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );

    res.json({
      items,
      calories: totals.calories,
      protein: totals.protein,
      carbs: totals.carbs,
      fat: totals.fat,
      verified: items.every((i) => i.verified),
    });
  } catch (err) {
    console.error("Meal estimate error:", err);
    res.status(500).json({ error: "Failed to estimate meal nutrition" });
  }
});

// Edit a previously logged meal (owner-checked by email).
router.put("/meals/:id", async (req, res) => {
  const {
    memberEmail, mealType, hadProtein, hadVegetable, hadWater, hadFruit, hadWholeFoods, notes,
    estimatedCalories, estimatedProtein, estimatedCarbs, estimatedFat, nutritionVerified,
  } = req.body as {
    memberEmail?: string;
    mealType?: string;
    hadProtein?: boolean;
    hadVegetable?: boolean;
    hadWater?: boolean;
    hadFruit?: boolean;
    hadWholeFoods?: boolean;
    notes?: string;
    estimatedCalories?: number | null;
    estimatedProtein?: number | null;
    estimatedCarbs?: number | null;
    estimatedFat?: number | null;
    nutritionVerified?: boolean | null;
  };

  if (!memberEmail) return res.status(400).json({ error: "memberEmail required" });

  try {
    const { rows } = await pool.query(
      `UPDATE meal_entries SET
         meal_type = COALESCE($3, meal_type),
         had_protein = COALESCE($4, had_protein),
         had_vegetable = COALESCE($5, had_vegetable),
         had_water = COALESCE($6, had_water),
         had_fruit = COALESCE($7, had_fruit),
         had_whole_foods = COALESCE($8, had_whole_foods),
         notes = $9,
         estimated_calories = $10,
         estimated_protein_g = $11,
         estimated_carbs_g = $12,
         estimated_fat_g = $13,
         nutrition_verified = $14
       WHERE id = $1 AND member_email = $2
       RETURNING id, meal_type, had_protein, had_vegetable, had_water, had_fruit, had_whole_foods, notes,
         estimated_calories,
         estimated_protein_g::float8 AS estimated_protein_g,
         estimated_carbs_g::float8 AS estimated_carbs_g,
         estimated_fat_g::float8 AS estimated_fat_g,
         nutrition_verified, logged_at`,
      [
        req.params.id,
        memberEmail.toLowerCase(),
        mealType ?? null,
        hadProtein ?? null,
        hadVegetable ?? null,
        hadWater ?? null,
        hadFruit ?? null,
        hadWholeFoods ?? null,
        notes ?? null,
        estimatedCalories != null ? Math.max(0, Math.round(Number(estimatedCalories))) : null,
        estimatedProtein != null ? Math.max(0, Math.round(Number(estimatedProtein))) : null,
        estimatedCarbs != null ? Math.max(0, Math.round(Number(estimatedCarbs))) : null,
        estimatedFat != null ? Math.max(0, Math.round(Number(estimatedFat))) : null,
        nutritionVerified ?? null,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Meal not found" });
    res.json({ meal: rows[0] });
  } catch (err) {
    console.error("Update meal error:", err);
    res.status(500).json({ error: "Failed to update meal" });
  }
});

// Delete a logged meal (owner-checked by email).
router.delete("/meals/:id", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rowCount } = await pool.query(
      "DELETE FROM meal_entries WHERE id = $1 AND member_email = $2",
      [req.params.id, email.toLowerCase()]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Meal not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete meal error:", err);
    res.status(500).json({ error: "Failed to delete meal" });
  }
});

// Log a meal entry and award points.
router.post("/meals", async (req, res) => {
  const {
    memberEmail, mealType, hadProtein, hadVegetable, hadWater, hadFruit, hadWholeFoods, notes,
    estimatedCalories, estimatedProtein, estimatedCarbs, estimatedFat, nutritionVerified,
  } = req.body as {
    memberEmail?: string;
    mealType?: string;
    hadProtein?: boolean;
    hadVegetable?: boolean;
    hadWater?: boolean;
    hadFruit?: boolean;
    hadWholeFoods?: boolean;
    notes?: string;
    estimatedCalories?: number;
    estimatedProtein?: number;
    estimatedCarbs?: number;
    estimatedFat?: number;
    nutritionVerified?: boolean;
  };

  if (!memberEmail || !mealType) {
    return res.status(400).json({ error: "memberEmail and mealType required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO meal_entries
         (member_email, meal_type, had_protein, had_vegetable, had_water, had_fruit, had_whole_foods, notes,
          estimated_calories, estimated_protein_g, estimated_carbs_g, estimated_fat_g, nutrition_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, meal_type, had_protein, had_vegetable, had_water, had_fruit, had_whole_foods, notes,
         estimated_calories,
         estimated_protein_g::float8 AS estimated_protein_g,
         estimated_carbs_g::float8 AS estimated_carbs_g,
         estimated_fat_g::float8 AS estimated_fat_g,
         nutrition_verified, logged_at`,
      [
        memberEmail.toLowerCase(),
        mealType,
        hadProtein ?? false,
        hadVegetable ?? false,
        hadWater ?? false,
        hadFruit ?? false,
        hadWholeFoods ?? false,
        notes ?? null,
        estimatedCalories != null ? Math.max(0, Math.round(Number(estimatedCalories))) : null,
        estimatedProtein != null ? Math.max(0, Math.round(Number(estimatedProtein))) : null,
        estimatedCarbs != null ? Math.max(0, Math.round(Number(estimatedCarbs))) : null,
        estimatedFat != null ? Math.max(0, Math.round(Number(estimatedFat))) : null,
        nutritionVerified ?? null,
      ]
    );

    await awardPoints(memberEmail.toLowerCase(), "meal_log", { mealType });

    res.status(201).json({ meal: rows[0] });
  } catch (err) {
    console.error("Log meal error:", err);
    res.status(500).json({ error: "Failed to log meal" });
  }
});

// Today's meals for a member.
router.get("/meals/today", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, meal_type, had_protein, had_vegetable, had_water, had_fruit, had_whole_foods, notes,
         estimated_calories,
         estimated_protein_g::float8 AS estimated_protein_g,
         estimated_carbs_g::float8 AS estimated_carbs_g,
         estimated_fat_g::float8 AS estimated_fat_g,
         nutrition_verified, logged_at
       FROM meal_entries
       WHERE member_email = $1
         AND logged_at >= ${SQL_DAY_START}
       ORDER BY logged_at ASC`,
      [email.toLowerCase()]
    );
    res.json({ meals: rows });
  } catch (err) {
    console.error("Fetch meals error:", err);
    res.status(500).json({ error: "Failed to fetch meals" });
  }
});

// Log today's step count (one entry per day, updated if re-submitted).
// Points: 1 pt per 1,000 steps, capped at 15 pts (15,000 steps).
router.post("/steps", async (req, res) => {
  const { memberEmail, steps } = req.body as { memberEmail?: string; steps?: number };
  if (!memberEmail || steps === undefined) {
    return res.status(400).json({ error: "memberEmail and steps required" });
  }

  const email = memberEmail.toLowerCase();
  const stepCount = Math.max(0, Math.min(Math.round(Number(steps)), 100_000));

  const { rows: memberRows } = await pool.query("SELECT email FROM members WHERE email = $1", [email]);
  if (memberRows.length === 0) return res.json({ ok: false, message: "Member not found" });

  try {
    const { rows: existing } = await pool.query(
      `SELECT id FROM step_entries WHERE member_email = $1 AND ${sqlSameDay("logged_at")}`,
      [email]
    );

    let entry;
    if (existing.length > 0) {
      const { rows } = await pool.query(
        `UPDATE step_entries SET steps = $2, logged_at = now() WHERE id = $1 RETURNING *`,
        [existing[0].id, stepCount]
      );
      entry = rows[0];
    } else {
      const { rows } = await pool.query(
        `INSERT INTO step_entries (member_email, steps) VALUES ($1, $2) RETURNING *`,
        [email, stepCount]
      );
      entry = rows[0];
    }

    // Points: replace any existing step points for today with the new amount
    const pointsToAward = Math.min(Math.floor(stepCount / 1000), 15);
    await pool.query(
      `DELETE FROM activity_logs WHERE member_email = $1 AND activity_type = 'steps'
         AND created_at >= ${SQL_DAY_START}`,
      [email]
    );
    if (pointsToAward > 0) {
      await pool.query(
        `INSERT INTO activity_logs (member_email, activity_type, points, metadata)
         VALUES ($1, 'steps', $2, $3)`,
        [email, pointsToAward, JSON.stringify({ steps: stepCount })]
      );
    }

    res.json({ ok: true, entry, points: pointsToAward });
  } catch (err) {
    console.error("Log steps error:", err);
    res.status(500).json({ error: "Failed to log steps" });
  }
});

// Today's step count for a member.
router.get("/steps/today", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(
      `SELECT steps, logged_at FROM step_entries
       WHERE member_email = $1 AND ${sqlSameDay("logged_at")}
       ORDER BY logged_at DESC LIMIT 1`,
      [email.toLowerCase()]
    );
    const entry = rows[0] ?? null;
    const steps = entry ? Number(entry.steps) : null;
    res.json({
      entry,
      steps,
      points: steps ? Math.min(Math.floor(steps / 1000), 15) : 0,
    });
  } catch (err) {
    console.error("Fetch steps error:", err);
    res.status(500).json({ error: "Failed to fetch steps" });
  }
});

// Current login streak for a member — used by the Home page banner.
router.get("/streak", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(
      `SELECT current_streak, longest_streak, last_login_date::text FROM login_streaks WHERE member_email = $1`,
      [email.toLowerCase()]
    );
    if (rows.length === 0) return res.json({ streak: null });

    const n = rows[0].current_streak;
    res.json({
      streak: {
        current_streak: n,
        longest_streak: rows[0].longest_streak,
        last_login_date: String(rows[0].last_login_date).slice(0, 10),
        todays_bonus: streakBonusPoints(n),
      },
    });
  } catch (err) {
    console.error("Streak fetch error:", err);
    res.status(500).json({ error: "Failed to fetch streak" });
  }
});

// Login streak detail for the Home page streak popup: current/longest streak,
// which of the last 7 calendar days (member-facing timezone) had a login, and
// progress toward the next milestone bonus.
router.get("/streak/history", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const lower = email.toLowerCase();
    const { rows: streakRows } = await pool.query(
      `SELECT current_streak, longest_streak, last_login_date::text FROM login_streaks WHERE member_email = $1`,
      [lower]
    );

    const todayStr = todayInTimezone();
    const last7Dates = Array.from({ length: 7 }, (_, i) => addDays(todayStr, i - 6));

    const { rows: loginRows } = await pool.query(
      `SELECT DISTINCT (created_at AT TIME ZONE 'America/New_York')::date::text AS day
       FROM activity_logs
       WHERE member_email = $1 AND activity_type = 'app_open'
         AND created_at >= now() - interval '7 days'`,
      [lower]
    );
    const loggedInDays = new Set(loginRows.map((r) => r.day));

    const history = last7Dates.map((date) => ({ date, loggedIn: loggedInDays.has(date) }));

    const currentStreak = streakRows.length > 0 ? streakRows[0].current_streak : 0;
    const longestStreak = streakRows.length > 0 ? streakRows[0].longest_streak : 0;

    const milestones = STREAK_MILESTONES.map((m) => ({ ...m, reached: currentStreak >= m.days }));
    const nextMilestone = STREAK_MILESTONES.find((m) => m.days > currentStreak) ?? null;

    res.json({
      currentStreak,
      longestStreak,
      history,
      milestones,
      nextMilestone: nextMilestone
        ? { days: nextMilestone.days, bonus: nextMilestone.bonus, daysRemaining: nextMilestone.days - currentStreak }
        : null,
    });
  } catch (err) {
    console.error("Streak history fetch error:", err);
    res.status(500).json({ error: "Failed to fetch streak history" });
  }
});

// Log sleep hours and quality, award points, and store for Well Check recs.
router.post("/sleep", async (req, res) => {
  const { memberEmail, hours, quality } = req.body as {
    memberEmail?: string;
    hours?: number;
    quality?: string;
  };

  const VALID_QUALITIES = ["not_enough", "enough", "needed_more", "feel_great"];
  if (!memberEmail || hours === undefined || !quality || !VALID_QUALITIES.includes(quality)) {
    return res.status(400).json({ error: "memberEmail, hours, and quality (not_enough|enough|needed_more|feel_great) required" });
  }

  const email = memberEmail.toLowerCase();
  const { rows: memberRows } = await pool.query("SELECT email FROM members WHERE email = $1", [email]);
  if (memberRows.length === 0) return res.json({ ok: false, message: "Member not found" });

  try {
    await pool.query(
      `INSERT INTO sleep_entries (member_email, hours, quality) VALUES ($1, $2, $3)`,
      [email, Math.min(Math.max(Number(hours), 1), 24), quality]
    );
    const award = await awardPoints(email, "sleep_log", { hours, quality });
    res.status(201).json({ ok: true, ...award });
  } catch (err) {
    console.error("Log sleep error:", err);
    res.status(500).json({ error: "Failed to log sleep" });
  }
});

// Today's sleep entry for the logged-in member (for Well Check recommendations).
router.get("/sleep/today", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(
      `SELECT hours, quality, logged_at
       FROM sleep_entries
       WHERE member_email = $1
         AND logged_at >= ${SQL_DAY_START}
       ORDER BY logged_at DESC
       LIMIT 1`,
      [email.toLowerCase()]
    );
    res.json({ entry: rows[0] ?? null });
  } catch (err) {
    console.error("Fetch sleep error:", err);
    res.status(500).json({ error: "Failed to fetch sleep" });
  }
});

// Sleep history for the last 30 days — used by the Sleep Analysis page.
router.get("/sleep/history", async (req, res) => {
  const { email, days } = req.query as { email?: string; days?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  const daysBack = Math.min(90, Math.max(7, parseInt(days ?? "30", 10)));

  try {
    const memberTz = await getMemberTimezone(email.toLowerCase());
    const loggedAtLocalDate = sqlLocalDateFor("logged_at", memberTz);
    const dayStart = sqlDayStartFor(memberTz);

    // DISTINCT ON picks the most-recent entry when multiple exist for the same
    // local date (can happen if health sync and a manual WellCheck log both ran).
    const { rows } = await pool.query(
      `SELECT date::text, hours, quality
       FROM (
         SELECT DISTINCT ON (${loggedAtLocalDate})
           ${loggedAtLocalDate} AS date,
           hours::float AS hours,
           quality
         FROM sleep_entries
         WHERE member_email = $1
           AND logged_at >= (${dayStart} - (($2::int - 1) * INTERVAL '1 day'))
         ORDER BY ${loggedAtLocalDate} ASC, logged_at DESC
       ) sub
       ORDER BY date ASC`,
      [email.toLowerCase(), daysBack]
    );

    res.json({ entries: rows });
  } catch (err) {
    console.error("Fetch sleep history error:", err);
    res.status(500).json({ error: "Failed to fetch sleep history" });
  }
});

// Point values guide (public — shown on profiles and in the app).
router.get("/points/guide", async (_req, res) => {
  res.json({ pointValues: POINT_VALUES, dailyCaps: DAILY_CAPS });
});

// Admin: manually award points to any member.
router.post("/points/admin-award", requireAdmin, async (req, res) => {
  const { memberEmail, points, reason } = req.body as {
    memberEmail?: string;
    points?: number;
    reason?: string;
  };

  if (!memberEmail || !points || !reason) {
    return res.status(400).json({ error: "memberEmail, points, and reason are required" });
  }
  const pts = Math.round(Number(points));
  if (isNaN(pts) || pts === 0) {
    return res.status(400).json({ error: "points must be a non-zero integer" });
  }

  try {
    const email = memberEmail.toLowerCase();
    await pool.query(
      `INSERT INTO activity_logs (member_email, activity_type, points, metadata)
       VALUES ($1, 'admin_award', $2, $3::jsonb)`,
      [email, pts, JSON.stringify({ reason })]
    );
    sendNotificationToUser(email, {
      title: `You earned ${pts} points! 🎉`,
      body: reason,
      tag: "admin-award",
      url: "/well-cup",
    }).catch(() => {});
    res.json({ awarded: true, points: pts });
  } catch (err) {
    console.error("Admin award points error:", err);
    res.status(500).json({ error: "Failed to award points" });
  }
});

export default router;
