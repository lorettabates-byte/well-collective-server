import { Router } from "express";
import { pool } from "../db";

const router = Router();

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
  daily_challenge_accept: 5,
};

// Max times a given activity type can earn points in one UTC day per member.
const DAILY_CAPS: Record<string, number> = {
  app_open: 1,
  blog_open: 1,
  sleep_log: 1,
  song_play: 5,
  class_watch: 3,
  tribe_add: 5,
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
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
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
    const result = await awardPoints(memberEmail.toLowerCase(), type, metadata);
    res.json(result);
  } catch (err) {
    console.error("Log activity error:", err);
    res.status(500).json({ error: "Failed to log activity" });
  }
});

// Today's leaderboard — members visible on the board, ordered by UTC-day points.
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
        AND al.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      WHERE m.show_on_leaderboard = TRUE
      GROUP BY m.email, m.name, m.avatar
      ORDER BY total_points DESC
      ${limitClause}
    `);

    res.json({
      leaderboard: rows.map((r) => ({
        email: r.email,
        name: r.name,
        avatar: r.avatar ?? null,
        points: Number(r.total_points),
      })),
      resetAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
    });
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// Yesterday's WELL CUP winner (awarded by the midnight cron job).
router.get("/leaderboard/yesterday", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT w.win_date, w.total_points, m.name, m.avatar, m.email
      FROM well_cup_wins w
      JOIN members m ON m.email = w.member_email
      WHERE w.win_date = CURRENT_DATE - INTERVAL '1 day'
    `);
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
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
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

// Log a meal entry and award points.
router.post("/meals", async (req, res) => {
  const { memberEmail, mealType, hadProtein, hadVegetable, hadWater, hadFruit, hadWholeFoods, notes } = req.body as {
    memberEmail?: string;
    mealType?: string;
    hadProtein?: boolean;
    hadVegetable?: boolean;
    hadWater?: boolean;
    hadFruit?: boolean;
    hadWholeFoods?: boolean;
    notes?: string;
  };

  if (!memberEmail || !mealType) {
    return res.status(400).json({ error: "memberEmail and mealType required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO meal_entries
         (member_email, meal_type, had_protein, had_vegetable, had_water, had_fruit, had_whole_foods, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, meal_type, had_protein, had_vegetable, had_water, had_fruit, had_whole_foods, notes, logged_at`,
      [
        memberEmail.toLowerCase(),
        mealType,
        hadProtein ?? false,
        hadVegetable ?? false,
        hadWater ?? false,
        hadFruit ?? false,
        hadWholeFoods ?? false,
        notes ?? null,
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
      `SELECT id, meal_type, had_protein, had_vegetable, had_water, had_fruit, had_whole_foods, notes, logged_at
       FROM meal_entries
       WHERE member_email = $1
         AND logged_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
       ORDER BY logged_at ASC`,
      [email.toLowerCase()]
    );
    res.json({ meals: rows });
  } catch (err) {
    console.error("Fetch meals error:", err);
    res.status(500).json({ error: "Failed to fetch meals" });
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
         AND logged_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
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
