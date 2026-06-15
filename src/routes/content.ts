import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { broadcastNotification } from "../push";
import type { ContentBatchEntry } from "../types";

const router = Router();

router.get("/content-schedule", requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT date, weekly_theme, daily_inspiration, well_activity, recipe
     FROM content_schedule ORDER BY date ASC`
  );

  const entries: ContentBatchEntry[] = rows.map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    weeklyTheme: row.weekly_theme ?? undefined,
    dailyInspiration: row.daily_inspiration ?? undefined,
    wellActivity: row.well_activity ?? undefined,
    recipe: row.recipe ?? undefined,
  }));

  res.json({ entries });
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

export default router;
