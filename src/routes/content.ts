import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { broadcastNotification } from "../push";
import type { ContentBatchEntry } from "../types";

const router = Router();

router.get("/content-schedule", requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT date, weekly_theme, daily_inspiration, well_activity, recipe, motivation_boost, nutrition_tip
     FROM content_schedule ORDER BY date ASC`
  );

  const entries: ContentBatchEntry[] = rows.map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    weeklyTheme: row.weekly_theme ?? undefined,
    dailyInspiration: row.daily_inspiration ?? undefined,
    wellActivity: row.well_activity ?? undefined,
    recipe: row.recipe ?? undefined,
    motivationBoost: row.motivation_boost ?? undefined,
    nutritionTip: row.nutrition_tip ?? undefined,
  }));

  res.json({ entries });
});

// Public: today's content only, for the member-facing app (no admin auth needed).
router.get("/content-today", async (_req, res) => {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.SCHEDULE_TIMEZONE || "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const today = formatter.format(new Date());

    const { rows } = await pool.query(
      `SELECT date, weekly_theme, daily_inspiration, well_activity, recipe, motivation_boost, nutrition_tip
       FROM content_schedule WHERE date = $1`,
      [today]
    );

    let weeklyTheme: { title: string; body: string } | undefined = rows[0]?.weekly_theme ?? undefined;
    if (!weeklyTheme) {
      for (let i = 1; i < 7 && !weeklyTheme; i++) {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - i);
        const checkDate = d.toISOString().slice(0, 10);
        const { rows: themeRows } = await pool.query("SELECT weekly_theme FROM content_schedule WHERE date = $1", [
          checkDate,
        ]);
        weeklyTheme = themeRows[0]?.weekly_theme ?? undefined;
      }
    }

    const entry: ContentBatchEntry | null = rows[0]
      ? {
          date: today,
          weeklyTheme: rows[0].weekly_theme ?? undefined,
          dailyInspiration: rows[0].daily_inspiration ?? undefined,
          wellActivity: rows[0].well_activity ?? undefined,
          recipe: rows[0].recipe ?? undefined,
          motivationBoost: rows[0].motivation_boost ?? undefined,
          nutritionTip: rows[0].nutrition_tip ?? undefined,
        }
      : null;

    res.json({ today: entry, currentWeeklyTheme: weeklyTheme ?? null });
  } catch (err) {
    console.error("Fetch content-today error:", err);
    res.status(500).json({ error: "Failed to fetch today's content" });
  }
});

// Public: paginated past recipes for the Nutrition page's "browse past
// recipes" view, going back from `before` (exclusive) rather than always
// starting at today, so members can keep paging further into the archive.
router.get("/recipes/history", async (req, res) => {
  try {
    const before = (req.query.before as string | undefined) || new Date().toISOString().slice(0, 10);
    const limit = Math.min(Number(req.query.limit) || 10, 30);

    const { rows } = await pool.query(
      `SELECT date, recipe FROM content_schedule
       WHERE date < $1 AND recipe IS NOT NULL
       ORDER BY date DESC
       LIMIT $2`,
      [before, limit]
    );

    res.json({
      recipes: rows.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        ...row.recipe,
      })),
    });
  } catch (err) {
    console.error("Fetch recipe history error:", err);
    res.status(500).json({ error: "Failed to fetch recipe history" });
  }
});

router.post("/content-schedule", requireAdmin, async (req, res) => {
  const entries = req.body as ContentBatchEntry[];
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: "Expected an array of content entries" });
  }

  for (const entry of entries) {
    if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      return res.status(400).json({ error: `Invalid date: ${entry.date}` });
    }
  }

  await Promise.all(
    entries.map((entry) =>
      pool.query(
        `INSERT INTO content_schedule (date, weekly_theme, daily_inspiration, well_activity, recipe)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (date) DO UPDATE SET
           weekly_theme = COALESCE($2, content_schedule.weekly_theme),
           daily_inspiration = COALESCE($3, content_schedule.daily_inspiration),
           well_activity = COALESCE($4, content_schedule.well_activity),
           recipe = COALESCE($5, content_schedule.recipe)`,
        [
          entry.date,
          entry.weeklyTheme ? JSON.stringify(entry.weeklyTheme) : null,
          entry.dailyInspiration ? JSON.stringify(entry.dailyInspiration) : null,
          entry.wellActivity ? JSON.stringify(entry.wellActivity) : null,
          entry.recipe ? JSON.stringify(entry.recipe) : null,
        ]
      )
    )
  );

  res.status(201).json({ ok: true, count: entries.length });
});

router.delete("/content-schedule/:date", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM content_schedule WHERE date = $1", [req.params.date]);
  res.json({ ok: true });
});

router.post("/send-test", requireAdmin, async (req, res) => {
  try {
    const { title, body } = req.body as { title?: string; body?: string };
    const result = await broadcastNotification({
      title: title || "WELL Collective",
      body: body || "This is a test notification from your WELL Collective app.",
      tag: "test",
    });
    res.json(result);
  } catch (err) {
    console.error("send-test error:", err);
    res.status(500).json({ error: "Failed to send test notification" });
  }
});

// Public: feed of the admin's instant/manual push notifications, surfaced in
// the app under Inspirations > "Notes from Loretta".
router.get("/notes", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, title, body, image, created_at FROM loretta_notes ORDER BY created_at DESC LIMIT 50"
    );
    res.json({
      notes: rows.map((row) => ({
        id: String(row.id),
        title: row.title,
        body: row.body,
        image: row.image ?? undefined,
        sentAt: row.created_at.toISOString(),
      })),
    });
  } catch (err) {
    console.error("Fetch notes error:", err);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

// Admin: send an instant push notification and persist it as a note.
router.post("/notes", requireAdmin, async (req, res) => {
  try {
    const { title, body, image } = req.body as { title?: string; body?: string; image?: string };
    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ error: "Title and body are required" });
    }

    const { rows } = await pool.query(
      "INSERT INTO loretta_notes (title, body, image) VALUES ($1, $2, $3) RETURNING id, title, body, image, created_at",
      [title.trim(), body.trim(), image || null]
    );
    const note = rows[0];

    const result = await broadcastNotification({
      title: note.title,
      body: note.body,
      tag: "loretta-note",
      url: "/inspirations",
    });

    res.status(201).json({
      note: {
        id: String(note.id),
        title: note.title,
        body: note.body,
        image: note.image ?? undefined,
        sentAt: note.created_at.toISOString(),
      },
      push: result,
    });
  } catch (err) {
    console.error("Create note error:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

export default router;
