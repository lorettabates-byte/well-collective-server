import { Router } from "express";
import { pool } from "../db";
import { todayInTimezone, addDays, SQL_DAY_START, SQL_MONTH_START, SQL_YEAR_START, sqlSameDay } from "../dateUtils";
import { isAnthropicConfigured, parseMealDescriptionForNutritionLookup } from "../anthropic";
import { isUsdaConfigured, computeNutritionFromIngredients } from "../usda";

const router = Router();

function streakBonusPoints(streak: number): number {
  if (streak >= 30) return 100;
  if (streak >= 14) return 50;
  if (streak >= 7) return 25;
  if (streak >= 4) return 10;
  if (streak >= 2) return 5;
  return 0;
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
  stretching: 15,
  resistance_training: 20,
  well_activity: 15,
  event_attend: 25,
  well_escape: 100,
  tribe_add: 5,
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
  blog_open: 5,
  sleep_log: 1,
  song_play: 5,
  class_watch: 3,
  tribe_add: 5,
  cardio: 1,
  daily_challenge_accept: 3,
  tutorial_complete: 1,
  notifications_enabled: 1,
  add_to_homescreen: 1,
};

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
    res.json({ leader: rows[0] ? { name: rows[0].name, avatar: rows[0].avatar ?? null, total_points: Number(rows[0].total_points) } : null });
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
    const items = await parseMealDescriptionForNutritionLookup(description.trim());
    const nutrition = await computeNutritionFromIngredients(items);
    if (!nutrition) {
      return res.status(422).json({ error: "Couldn't estimate nutrition for that description" });
    }
    res.json({
      calories: nutrition.calories,
      protein: parseInt(nutrition.protein, 10) || 0,
      carbs: parseInt(nutrition.carbs, 10) || 0,
      fat: parseInt(nutrition.fat, 10) || 0,
      verified: nutrition.verified,
    });
  } catch (err) {
    console.error("Meal estimate error:", err);
    res.status(500).json({ error: "Failed to estimate meal nutrition" });
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
         estimated_calories, estimated_protein_g, estimated_carbs_g, estimated_fat_g, nutrition_verified, logged_at`,
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
         estimated_calories, estimated_protein_g, estimated_carbs_g, estimated_fat_g, nutrition_verified, logged_at
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
    res.json({ entry: rows[0] ?? null });
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
    const bonus = n >= 30 ? 100 : n >= 14 ? 50 : n >= 7 ? 25 : n >= 4 ? 10 : n >= 2 ? 5 : 0;
    res.json({
      streak: {
        current_streak: n,
        longest_streak: rows[0].longest_streak,
        last_login_date: String(rows[0].last_login_date).slice(0, 10),
        todays_bonus: bonus,
      },
    });
  } catch (err) {
    console.error("Streak fetch error:", err);
    res.status(500).json({ error: "Failed to fetch streak" });
  }
});

// Log sleep hours and quality, award points, and store for Well Check recs.
router.post("/sleep", async (req, res) => {
  const { memberEmail, hours, quality } = req.body as {
    memberEmail?: string;
    hours?: number;
    quality?: string;
  };

  const VALID_QUALITIES = ["not_enough", "enough", "needed_more"];
  if (!memberEmail || hours === undefined || !quality || !VALID_QUALITIES.includes(quality)) {
    return res.status(400).json({ error: "memberEmail, hours, and quality (not_enough|enough|needed_more) required" });
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

// Point values guide (public — shown on profiles and in the app).
router.get("/points/guide", async (_req, res) => {
  res.json({ pointValues: POINT_VALUES, dailyCaps: DAILY_CAPS });
});

export default router;
