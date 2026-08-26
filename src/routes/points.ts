import { Router } from "express";
import { pool } from "../db";
import { todayInTimezone, addDays, SQL_DAY_START, SQL_MONTH_START, SQL_YEAR_START, sqlSameDay, TIMEZONE, CRON_TIMEZONE } from "../dateUtils";
import { isAnthropicConfigured, parseMealDescriptionForNutritionLookup } from "../anthropic";
import { isUsdaConfigured, computeNutritionFromIngredients } from "../usda";
import { requireAdmin } from "../middleware/adminAuth";
import { sendNotificationToUser } from "../push";
import { autoAdvanceChallengeGoal } from "./tribe";

// Maps activity types to the tribe challenge(s) they should auto-advance.
const ACTIVITY_CHALLENGE_MAP: Record<string, string[]> = {
  meal_log:            ["nourishment-3day"],
  resistance_training: ["workout-streak-7"],
  cardio:              ["workout-streak-7"],
  stretching:          ["workout-streak-7"],
  class_watch:         ["workout-streak-7"],
  breathwork:          ["mindfulness-5"],
  breathwork_extended: ["mindfulness-5"],
  breathwork_calm_kit: ["mindfulness-5"],
  well_activity:       ["wellcheck-7"],
  sleep_log:           ["wellcheck-7"],
};

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
  { days: 60, bonus: 150 },
  { days: 90, bonus: 250 },
  { days: 180, bonus: 500 },
  { days: 365, bonus: 1000 },
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
  brain_game: 20,
  event_attend: 25,
  well_escape: 100,
  tribe_add: 5,
  tribe_cheer: 5,
  tribe_card: 10,
  tribe_challenge_complete: 25,
  cardio: 20,
  daily_challenge_accept: 10,
  tutorial_complete: 50,
  notifications_enabled: 20,
  add_to_homescreen: 25,
  login_streak_bonus: 0, // variable — awarded directly in updateLoginStreak
};

// Activities that can only ever award points once per member lifetime (not just once per day).
const LIFETIME_CAPS = new Set(["tutorial_complete", "notifications_enabled", "add_to_homescreen"]);

// Max times a given activity type can earn points in one calendar day (member-facing timezone) per member.
const DAILY_CAPS: Record<string, number> = {
  app_open: 1,
  blog_open: 2,
  sleep_log: 1,
  song_play: 5,
  class_watch: 1,
  meal_log: 4,
  tribe_add: 5,
  tribe_cheer: 3,
  tribe_card: 2,
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
  brain_game: 1,
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

  if (LIFETIME_CAPS.has(activityType)) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count FROM activity_logs WHERE member_email = $1 AND activity_type = $2`,
      [memberEmail, activityType]
    );
    if (Number(rows[0].count) >= 1) return { awarded: false, points: 0 };
  }

  const cap = DAILY_CAPS[activityType];
  if (cap !== undefined) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count FROM activity_logs
       WHERE member_email = $1 AND activity_type = $2
         AND created_at >= ${SQL_DAY_START}`,
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
    await pool.query(
      `DELETE FROM activity_logs
       WHERE id = (
         SELECT id FROM activity_logs
         WHERE member_email = $1 AND activity_type = $2
           AND created_at >= ${SQL_DAY_START}
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

      // morning-ritual-5 challenge: WELL Check before noon in the server tz.
      const hour = new Date().toLocaleString("en-US", { timeZone: CRON_TIMEZONE, hour: "numeric", hour12: false });
      if (Number(hour) < 12) {
        autoAdvanceChallengeGoal(email, "morning-ritual-5").catch(() => {});
      }
    }

    // Auto-advance any tribe challenges tied to this activity type.
    const challengeKeys = ACTIVITY_CHALLENGE_MAP[type] ?? [];
    for (const key of challengeKeys) {
      autoAdvanceChallengeGoal(email, key).catch(() => {});
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
        AND (m.last_daily_win_at IS NULL OR m.last_daily_win_at < ${SQL_DAY_START})
        AND NOT EXISTS (
          SELECT 1 FROM well_cup_wins wcw
          WHERE wcw.member_email = m.email
            AND wcw.win_date = (now() - INTERVAL '5 hours')::date - INTERVAL '1 day'
        )
        AND (m.last_monthly_win_at IS NULL
             OR date_trunc('month', m.last_monthly_win_at AT TIME ZONE 'UTC')
                != date_trunc('month', (now() - INTERVAL '5 hours')::date) - INTERVAL '1 month')
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
        AND (m.last_monthly_win_at IS NULL
             OR date_trunc('month', m.last_monthly_win_at AT TIME ZONE '${TIMEZONE}')
                != date_trunc('month', (now() AT TIME ZONE '${TIMEZONE}') - INTERVAL '1 month'))
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
        AND (m.last_yearly_win_at IS NULL
             OR date_trunc('year', m.last_yearly_win_at AT TIME ZONE '${TIMEZONE}')
                != date_trunc('year', (now() AT TIME ZONE '${TIMEZONE}') - INTERVAL '1 year'))
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

// Most Consistent this month — member with the most distinct calendar days with any points earned.
// Céline's total-points lead is irrelevant here; showing up consistently is all that matters.
router.get("/leaderboard/most-consistent", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.email, m.name, m.avatar,
             COUNT(DISTINCT (al.created_at AT TIME ZONE '${TIMEZONE}')::date) AS active_days
      FROM members m
      JOIN activity_logs al ON al.member_email = m.email
        AND al.created_at >= ${SQL_MONTH_START}
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.avatar
      ORDER BY active_days DESC
      LIMIT 1
    `);
    res.json({
      leader: rows[0]
        ? { name: rows[0].name, avatar: rows[0].avatar ?? null, email: rows[0].email, active_days: Number(rows[0].active_days) }
        : null,
    });
  } catch (err) {
    console.error("Most-consistent leader error:", err);
    res.status(500).json({ error: "Failed to fetch most-consistent leader" });
  }
});

// Most Well-Rounded this week — member who logged the most distinct activity categories
// (e.g., workout + sleep + nutrition + breathwork) in the current calendar week.
router.get("/leaderboard/most-rounded", async (_req, res) => {
  const WELL_ACTIVITY_TYPES = [
    "cardio", "class_watch", "sleep_log", "meal_log",
    "breathwork", "breathwork_extended", "breathwork_calm_kit",
    "stretching", "resistance_training", "well_activity", "brain_game",
    "forum_post", "event_attend", "tribe_challenge_complete",
  ];
  const SQL_WEEK_START = `date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'`;
  try {
    const { rows } = await pool.query(`
      SELECT m.email, m.name, m.avatar,
             COUNT(DISTINCT al.activity_type) AS category_count
      FROM members m
      JOIN activity_logs al ON al.member_email = m.email
        AND al.created_at >= ${SQL_WEEK_START}
        AND al.activity_type = ANY($1)
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.avatar
      ORDER BY category_count DESC
      LIMIT 1
    `, [WELL_ACTIVITY_TYPES]);
    res.json({
      leader: rows[0]
        ? { name: rows[0].name, avatar: rows[0].avatar ?? null, email: rows[0].email, category_count: Number(rows[0].category_count) }
        : null,
    });
  } catch (err) {
    console.error("Most-rounded leader error:", err);
    res.status(500).json({ error: "Failed to fetch most-rounded leader" });
  }
});

// Most Improved — always shows the previous completed Mon-Sun week so the award
// stays locked in all week and doesn't shift as members earn points mid-week.
router.get("/leaderboard/most-improved", async (_req, res) => {
  const SQL_WEEK_START      = `date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'`;
  const SQL_PREV_WEEK_START = `(date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}' - INTERVAL '7 days')`;
  const SQL_TWO_WEEKS_AGO   = `(date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}' - INTERVAL '14 days')`;

  const query = (windowStart: string, windowEnd: string, baselineStart: string, baselineEnd: string) => pool.query(`
    WITH curr AS (
      SELECT member_email, COALESCE(SUM(points), 0) AS pts
      FROM activity_logs
      WHERE created_at >= ${windowStart} AND created_at < ${windowEnd}
      GROUP BY member_email
    ),
    prev AS (
      SELECT member_email, COALESCE(SUM(points), 0) AS pts
      FROM activity_logs
      WHERE created_at >= ${baselineStart} AND created_at < ${baselineEnd}
      GROUP BY member_email
    )
    SELECT m.email, m.name, m.avatar,
           COALESCE(c.pts, 0) AS this_week_pts,
           COALESCE(p.pts, 0) AS last_week_pts,
           COALESCE(c.pts, 0) - COALESCE(p.pts, 0) AS improvement
    FROM members m
    LEFT JOIN curr c ON c.member_email = m.email
    LEFT JOIN prev p ON p.member_email = m.email
    WHERE m.show_on_leaderboard = TRUE
      AND COALESCE(c.pts, 0) > 0
      AND COALESCE(c.pts, 0) > COALESCE(p.pts, 0)
    ORDER BY improvement DESC
    LIMIT 1
  `);

  try {
    // Always use the previous completed week (Mon–Sun) so the winner is locked
    // in on Monday and doesn't change as members earn points mid-week.
    let { rows } = await query(SQL_PREV_WEEK_START, SQL_WEEK_START, SQL_TWO_WEEKS_AGO, SQL_PREV_WEEK_START);
    if (!rows.length) {
      // Fallback to two weeks ago vs three weeks ago when last week has no data
      const SQL_THREE_WEEKS_AGO = `(date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}' - INTERVAL '21 days')`;
      ({ rows } = await query(SQL_TWO_WEEKS_AGO, SQL_PREV_WEEK_START, SQL_THREE_WEEKS_AGO, SQL_TWO_WEEKS_AGO));
    }
    res.json({
      leader: rows[0]
        ? {
            name: rows[0].name,
            avatar: rows[0].avatar ?? null,
            email: rows[0].email,
            improvement: Number(rows[0].improvement),
            this_week_pts: Number(rows[0].this_week_pts),
            last_week_pts: Number(rows[0].last_week_pts),
          }
        : null,
    });
  } catch (err) {
    console.error("Most-improved leader error:", err);
    res.status(500).json({ error: "Failed to fetch most-improved leader" });
  }
});

// Comeback Story — always shows the previous completed Mon-Sun week so the winner
// stays locked in all week and doesn't shift as members earn points mid-week.
router.get("/leaderboard/comeback", async (_req, res) => {
  const SQL_WEEK_START      = `date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'`;
  const SQL_PREV_WEEK_START = `(date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}' - INTERVAL '7 days')`;
  const SQL_TWO_WEEKS_AGO   = `(date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}' - INTERVAL '14 days')`;

  const query = (windowStart: string, windowEnd: string, baselineStart: string, baselineEnd: string) => pool.query(`
    WITH curr AS (
      SELECT member_email, COALESCE(SUM(points), 0) AS pts
      FROM activity_logs
      WHERE created_at >= ${windowStart} AND created_at < ${windowEnd}
      GROUP BY member_email
    ),
    prev AS (
      SELECT member_email, COALESCE(SUM(points), 0) AS pts
      FROM activity_logs
      WHERE created_at >= ${baselineStart} AND created_at < ${baselineEnd}
      GROUP BY member_email
    )
    SELECT m.email, m.name, m.avatar, c.pts AS this_week_pts
    FROM members m
    JOIN curr c ON c.member_email = m.email
    LEFT JOIN prev p ON p.member_email = m.email
    WHERE m.show_on_leaderboard = TRUE
      AND c.pts > 0
      AND COALESCE(p.pts, 0) = 0
    ORDER BY c.pts DESC
    LIMIT 1
  `);

  try {
    // Always use the previous completed week so the winner is locked in Monday
    // and doesn't change as members earn points mid-week.
    let { rows } = await query(SQL_PREV_WEEK_START, SQL_WEEK_START, SQL_TWO_WEEKS_AGO, SQL_PREV_WEEK_START);
    if (!rows.length) {
      const SQL_THREE_WEEKS_AGO = `(date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}' - INTERVAL '21 days')`;
      ({ rows } = await query(SQL_TWO_WEEKS_AGO, SQL_PREV_WEEK_START, SQL_THREE_WEEKS_AGO, SQL_TWO_WEEKS_AGO));
    }
    res.json({
      leader: rows[0]
        ? { name: rows[0].name, avatar: rows[0].avatar ?? null, email: rows[0].email, this_week_pts: Number(rows[0].this_week_pts) }
        : null,
    });
  } catch (err) {
    console.error("Comeback leader error:", err);
    res.status(500).json({ error: "Failed to fetch comeback leader" });
  }
});

// Weekend Warrior this month — most points earned specifically on Saturdays and Sundays.
// Céline's weekday grind can't carry into a weekend-only ranking.
router.get("/leaderboard/weekend-warrior", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.email, m.name, m.avatar, COALESCE(SUM(al.points), 0) AS weekend_pts
      FROM members m
      JOIN activity_logs al ON al.member_email = m.email
        AND al.created_at >= ${SQL_MONTH_START}
        AND EXTRACT(DOW FROM al.created_at AT TIME ZONE '${TIMEZONE}') IN (0, 6)
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.avatar
      ORDER BY weekend_pts DESC
      LIMIT 1
    `);
    res.json({
      leader: rows[0]
        ? { name: rows[0].name, avatar: rows[0].avatar ?? null, email: rows[0].email, weekend_pts: Number(rows[0].weekend_pts) }
        : null,
    });
  } catch (err) {
    console.error("Weekend warrior error:", err);
    res.status(500).json({ error: "Failed to fetch weekend warrior" });
  }
});

// Weekly Lucky Draw — deterministic-random pick among all members with 20+ pts this week.
// Weekly Spotlight — deterministic pick from members who earned 20+ pts LAST week.
// Using last week (not this week) keeps the pool stable all week long; this week's
// pool grows as people log points, which would cause the selected winner to change
// throughout the day. The winner is cached in weekly_spotlight on first request and
// can be manually overridden by an admin via PATCH /leaderboard/spotlight-override.
router.get("/leaderboard/lucky-draw", async (_req, res) => {
  const SQL_WEEK_START      = `date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'`;
  const SQL_PREV_WEEK_START = `(date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}' - INTERVAL '7 days')`;
  try {
    // Return the cached winner for this week if it exists (includes manual overrides)
    const { rows: cached } = await pool.query(
      `SELECT email, name, avatar FROM weekly_spotlight WHERE week_start = (${SQL_WEEK_START})::date`
    );
    if (cached.length) {
      return res.json({ leader: { name: cached[0].name, avatar: cached[0].avatar ?? null, email: cached[0].email } });
    }

    // Compute winner from last week's pool
    const { rows } = await pool.query(`
      SELECT m.email, m.name, m.avatar
      FROM members m
      JOIN activity_logs al ON al.member_email = m.email
        AND al.created_at >= ${SQL_PREV_WEEK_START}
        AND al.created_at < ${SQL_WEEK_START}
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.avatar
      HAVING COALESCE(SUM(al.points), 0) >= 20
      ORDER BY m.email
    `);
    if (!rows.length) return res.json({ leader: null });
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.floor((now.getTime() - startOfYear.getTime()) / (7 * 24 * 60 * 60 * 1000));
    const winner = rows[weekNum % rows.length];

    // Cache so the winner stays stable even if the pool changes
    await pool.query(
      `INSERT INTO weekly_spotlight (week_start, email, name, avatar)
       VALUES ((${SQL_WEEK_START})::date, $1, $2, $3)
       ON CONFLICT (week_start) DO NOTHING`,
      [winner.email, winner.name, winner.avatar ?? null]
    );

    res.json({ leader: { name: winner.name, avatar: winner.avatar ?? null, email: winner.email } });
  } catch (err) {
    console.error("Lucky draw error:", err);
    res.status(500).json({ error: "Failed to fetch lucky draw" });
  }
});

// Admin: list all daily WELL Cup wins, optionally filtered by member email.
router.get("/admin/well-cup-wins", requireAdmin, async (req, res) => {
  const { email } = req.query as { email?: string };
  try {
    const { rows } = await pool.query(
      `SELECT w.win_date, w.total_points, w.member_email, m.name
       FROM well_cup_wins w
       JOIN members m ON m.email = w.member_email
       ${email ? "WHERE w.member_email = $1" : ""}
       ORDER BY w.win_date DESC
       LIMIT 60`,
      email ? [email.toLowerCase().trim()] : []
    );
    res.json({ wins: rows.map(r => ({ date: r.win_date, email: r.member_email, name: r.name, points: Number(r.total_points) })) });
  } catch (err) {
    console.error("Well cup wins error:", err);
    res.status(500).json({ error: "Failed to fetch wins" });
  }
});

// Admin — manually set this week's Community Spotlight winner.
// Body: { email: string }
router.patch("/leaderboard/spotlight-override", requireAdmin, async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });
  const SQL_WEEK_START = `date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'`;
  try {
    const { rows } = await pool.query(`SELECT email, name, avatar FROM members WHERE email = $1`, [email.toLowerCase()]);
    if (!rows.length) return res.status(404).json({ error: "Member not found" });
    const m = rows[0];
    await pool.query(
      `INSERT INTO weekly_spotlight (week_start, email, name, avatar, updated_at)
       VALUES ((${SQL_WEEK_START})::date, $1, $2, $3, now())
       ON CONFLICT (week_start) DO UPDATE SET email = $1, name = $2, avatar = $3, updated_at = now()`,
      [m.email, m.name, m.avatar ?? null]
    );
    res.json({ ok: true, leader: { email: m.email, name: m.name, avatar: m.avatar ?? null } });
  } catch (err) {
    console.error("Spotlight override error:", err);
    res.status(500).json({ error: "Failed to set spotlight override" });
  }
});

// Personal stats for a member — their own personal bests regardless of rank.
router.get("/stats/me", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });
  const e = (email as string).toLowerCase();
  try {
    const [bestDayRes, activeDaysRes, streakRes, categoriesRes] = await Promise.all([
      pool.query(`
        SELECT COALESCE(MAX(daily_pts), 0) AS best_day
        FROM (
          SELECT SUM(points) AS daily_pts
          FROM activity_logs
          WHERE member_email = $1
          GROUP BY (created_at AT TIME ZONE '${TIMEZONE}')::date
        ) sub
      `, [e]),
      pool.query(`
        SELECT COUNT(DISTINCT (created_at AT TIME ZONE '${TIMEZONE}')::date) AS active_days
        FROM activity_logs
        WHERE member_email = $1
          AND created_at >= ${SQL_MONTH_START}
      `, [e]),
      pool.query(`
        SELECT current_streak, longest_streak
        FROM login_streaks
        WHERE member_email = $1
      `, [e]),
      pool.query(`
        SELECT COUNT(DISTINCT activity_type) AS categories
        FROM activity_logs
        WHERE member_email = $1
          AND created_at >= date_trunc('week', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'
      `, [e]),
    ]);
    res.json({
      bestDay: Number(bestDayRes.rows[0]?.best_day ?? 0),
      activeDaysThisMonth: Number(activeDaysRes.rows[0]?.active_days ?? 0),
      currentStreak: Number(streakRes.rows[0]?.current_streak ?? 0),
      longestStreak: Number(streakRes.rows[0]?.longest_streak ?? 0),
      categoriesThisWeek: Number(categoriesRes.rows[0]?.categories ?? 0),
    });
  } catch (err) {
    console.error("Personal stats error:", err);
    res.status(500).json({ error: "Failed to fetch personal stats" });
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

// Admin: show all members' raw points for a competition day window plus eligibility flags.
// ?date=YYYY-MM-DD  (win_date — competition runs from that date 05:00 UTC to +24h)
router.get("/admin/competition-day-scores", requireAdmin, async (req, res) => {
  const { date } = req.query as { date?: string };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date required (YYYY-MM-DD)" });
  }
  try {
    const { rows } = await pool.query(`
      SELECT
        m.email, m.name,
        COALESCE(SUM(al.points),0)::int AS total,
        m.show_on_leaderboard,
        m.last_monthly_win_at,
        EXISTS (
          SELECT 1 FROM well_cup_wins wcw
          WHERE wcw.member_email = m.email AND wcw.win_date = ($1::date - 1)
        ) AS won_yesterday,
        (m.last_monthly_win_at IS NOT NULL
         AND date_trunc('month', m.last_monthly_win_at AT TIME ZONE 'UTC')
             = date_trunc('month', $1::date) - INTERVAL '1 month') AS won_last_month_prize
      FROM members m
      LEFT JOIN activity_logs al ON al.member_email = m.email
        AND al.created_at >= $1::date + INTERVAL '5 hours'
        AND al.created_at <  $1::date + INTERVAL '29 hours'
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.show_on_leaderboard, m.last_monthly_win_at
      HAVING COALESCE(SUM(al.points),0) > 0
      ORDER BY total DESC
      LIMIT 30
    `, [date]);
    res.json({
      date,
      scores: rows.map(r => ({
        email: r.email,
        name: r.name,
        points: r.total,
        eligible: !r.won_yesterday && !r.won_last_month_prize,
        wonYesterday: r.won_yesterday,
        wonLastMonthPrize: r.won_last_month_prize,
        lastMonthlyWinAt: r.last_monthly_win_at,
      }))
    });
  } catch (err) {
    console.error("Competition day scores error:", err);
    res.status(500).json({ error: "Failed to fetch scores" });
  }
});

// Admin: re-run winner selection for a specific past date and correct the record.
// Use this to fix cases where an ineligible member was crowned (e.g. after a bug).
// Body: { date: "YYYY-MM-DD" }
router.post("/admin/recrown-daily-winner", requireAdmin, async (req, res) => {
  const { date } = req.body as { date?: string };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date required (YYYY-MM-DD)" });
  }

  try {
    // What's already recorded for this date?
    const { rows: existing } = await pool.query(
      `SELECT member_email, total_points FROM well_cup_wins WHERE win_date = $1`,
      [date]
    );
    const oldWinner = existing[0]?.member_email ?? null;

    // Re-run eligibility with correct rules:
    //   - Can't win two days in a row (won the day before)
    //   - Can't win if they won any day last calendar month
    // Time window: competition day D runs from D 05:00 UTC to (D+1) 05:00 UTC.
    const { rows } = await pool.query(`
      SELECT al.member_email, SUM(al.points)::int AS total
      FROM activity_logs al
      JOIN members m ON m.email = al.member_email
      WHERE al.created_at >= $1::date + INTERVAL '5 hours'
        AND al.created_at <  $1::date + INTERVAL '29 hours'
        AND m.show_on_leaderboard = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM well_cup_wins wcw
          WHERE wcw.member_email = m.email
            AND wcw.win_date = ($1::date - 1)
        )
        AND (m.last_monthly_win_at IS NULL
             OR date_trunc('month', m.last_monthly_win_at AT TIME ZONE 'UTC')
                != date_trunc('month', $1::date) - INTERVAL '1 month')
      GROUP BY al.member_email
      ORDER BY total DESC
      LIMIT 1
    `, [date]);

    if (rows.length === 0) {
      return res.json({ ok: true, oldWinner, newWinner: null, message: "No eligible winner found for that date" });
    }

    const newWinner = rows[0].member_email as string;
    const newTotal = rows[0].total as number;

    if (oldWinner === newWinner) {
      return res.json({ ok: true, oldWinner, newWinner, message: "Winner unchanged — already correct" });
    }

    // Remove incorrect win record and clear that member's last_daily_win_at if it was set by this win
    if (oldWinner) {
      await pool.query(`DELETE FROM well_cup_wins WHERE win_date = $1`, [date]);
      await pool.query(
        `UPDATE members SET last_daily_win_at = NULL WHERE email = $1
           AND last_daily_win_at >= $2::date + INTERVAL '5 hours'
           AND last_daily_win_at <  $2::date + INTERVAL '29 hours'`,
        [oldWinner, date]
      );
    }

    // Insert correct winner
    await pool.query(
      `INSERT INTO well_cup_wins (member_email, win_date, total_points)
       VALUES ($1, $2, $3) ON CONFLICT (win_date) DO UPDATE SET member_email=$1, total_points=$3`,
      [newWinner, date, newTotal]
    );
    await pool.query(
      `UPDATE members SET last_daily_win_at = NOW(), last_daily_win_pts = $2 WHERE email = $1`,
      [newWinner, newTotal]
    );

    // Notify the real winner
    await sendNotificationToUser(newWinner, {
      title: "You won the WELL Cup!",
      body: `${newTotal.toLocaleString()} points — you led the board. Open the app to see your win!`,
      tag: "well-cup-win",
      url: "/well-cup",
    }).catch(() => {});

    console.log(`[WELL CUP] Re-crowned ${date}: ${oldWinner} → ${newWinner} (${newTotal} pts)`);
    res.json({ ok: true, oldWinner, newWinner, points: newTotal });
  } catch (err) {
    console.error("Recrown error:", err);
    res.status(500).json({ error: "Failed to recrown winner" });
  }
});

// A member's own activity breakdown for today (for the Well Check).
router.get("/activity/today", async (req, res) => {
  const { email } = req.query as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const memberEmail = email.toLowerCase();

    const { rows } = await pool.query(`
      SELECT activity_type, SUM(points) AS points, COUNT(*) AS count
      FROM activity_logs
      WHERE member_email = $1
        AND created_at >= ${SQL_DAY_START}
      GROUP BY activity_type
    `, [memberEmail]);

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
    // Auto-advance hydration challenge when water is checked on a meal update.
    if (rows[0].had_water === true) {
      autoAdvanceChallengeGoal(memberEmail.toLowerCase(), "hydration-5").catch(() => {});
    }
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
    if (hadWater) {
      autoAdvanceChallengeGoal(memberEmail.toLowerCase(), "hydration-5").catch(() => {});
    }

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

// Admin: remove all event_attend points awarded at RSVP time (before the post-event
// scheduler fix). Deletes the activity_log rows and reports how many points were removed.
// Pass dryRun=true to preview without changing anything.
router.post("/points/admin-remove-rsvp-points", requireAdmin, async (req, res) => {
  const { memberEmail, dryRun } = req.body as { memberEmail?: string; dryRun?: boolean };
  if (!memberEmail) return res.status(400).json({ error: "memberEmail required" });

  const email = memberEmail.toLowerCase().trim();
  try {
    const { rows } = await pool.query(
      `SELECT id, points, created_at FROM activity_logs
       WHERE member_email = $1 AND activity_type = 'event_attend'
       ORDER BY created_at DESC`,
      [email]
    );

    const totalPoints = rows.reduce((sum: number, r: { points: number }) => sum + Number(r.points), 0);
    const count = rows.length;

    if (dryRun || count === 0) {
      return res.json({ dryRun: true, email, count, totalPoints, rows });
    }

    await pool.query(
      `DELETE FROM activity_logs WHERE member_email = $1 AND activity_type = 'event_attend'`,
      [email]
    );

    console.log(`[ADMIN] Removed ${count} event_attend entries (${totalPoints} pts) for ${email}`);
    res.json({ ok: true, email, removed: count, pointsRemoved: totalPoints });
  } catch (err) {
    console.error("Remove RSVP points error:", err);
    res.status(500).json({ error: "Failed to remove points" });
  }
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
