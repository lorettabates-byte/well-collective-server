import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { broadcastNotification } from "../push";
import type { ContentBatchEntry } from "../types";
import { parseIngredientsForNutritionLookup } from "../anthropic";
import { computeNutritionFromIngredients } from "../usda";
import { PHOTOS, resolveCategory } from "../recipePhotos";

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

// One-time admin tool: recipes generated before nutritionLookup existed
// have no way to get USDA-verified nutrition retroactively unless we parse
// their existing ingredient list into the lookup format after the fact.
// Safe to run repeatedly — skips any recipe that's already nutritionVerified.
router.post("/recipes/backfill-nutrition", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT date, recipe FROM content_schedule
       WHERE recipe IS NOT NULL AND COALESCE((recipe->>'nutritionVerified')::boolean, false) = false
       ORDER BY date DESC`
    );

    const results: { date: string; name: string; verified: boolean }[] = [];

    for (const row of rows) {
      const date = row.date.toISOString().slice(0, 10);
      const recipe = row.recipe as { name: string; ingredients: string[] };
      try {
        const lookup = await parseIngredientsForNutritionLookup(recipe.ingredients);
        const usdaNutrition = await computeNutritionFromIngredients(lookup);
        if (!usdaNutrition) {
          results.push({ date, name: recipe.name, verified: false });
          continue;
        }
        const { verified, ...nutrition } = usdaNutrition;
        const updatedRecipe = { ...recipe, nutrition, nutritionVerified: verified, nutritionLookup: lookup };
        await pool.query(`UPDATE content_schedule SET recipe = $1 WHERE date = $2`, [
          JSON.stringify(updatedRecipe),
          date,
        ]);
        results.push({ date, name: recipe.name, verified });
      } catch (err) {
        console.error(`Backfill failed for ${date} (${recipe.name}):`, err);
        results.push({ date, name: recipe.name, verified: false });
      }
    }

    res.json({ processed: results.length, results });
  } catch (err) {
    console.error("Recipe nutrition backfill error:", err);
    res.status(500).json({ error: "Failed to backfill recipe nutrition" });
  }
});

// One-time admin tool: recipes are normally given a photo on the fly by
// hashing the recipe name within its category's photo pool, which means two
// recipes with the literal same name (the AI repeating a dish before the
// variety fix shipped) always land on the exact same photo no matter how
// big the pool is. This walks recent recipes newest-first and assigns each
// an explicit `image` override, skipping any photo already used by a more
// recent recipe in the same category so duplicates can't happen — falling
// back to allowing reuse only once a category's whole pool is exhausted.
router.post("/recipes/diversify-photos", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT date, recipe FROM content_schedule WHERE recipe IS NOT NULL ORDER BY date DESC`
    );

    const usedByCategory = new Map<string, Set<string>>();
    const results: { date: string; name: string; image: string }[] = [];

    for (const row of rows) {
      const date = row.date.toISOString().slice(0, 10);
      const recipe = row.recipe as {
        name: string;
        ingredients: string[];
        imageCategory?: string;
        [key: string]: unknown;
      };

      const category = resolveCategory(recipe.name, recipe.ingredients ?? [], recipe.imageCategory);
      const pool_ = PHOTOS[category] ?? PHOTOS.general_healthy;
      const used = usedByCategory.get(category) ?? new Set<string>();

      let chosen = pool_.find((photo) => !used.has(photo));
      if (!chosen) {
        // Whole pool already used by more recent recipes in this category —
        // reuse is unavoidable once there are more recipes than photos.
        used.clear();
        chosen = pool_[0];
      }
      used.add(chosen);
      usedByCategory.set(category, used);

      const updatedRecipe = { ...recipe, image: chosen, imageCategory: category };
      await pool.query(`UPDATE content_schedule SET recipe = $1 WHERE date = $2`, [
        JSON.stringify(updatedRecipe),
        date,
      ]);
      results.push({ date, name: recipe.name, image: chosen });
    }

    res.json({ processed: results.length, results });
  } catch (err) {
    console.error("Recipe photo diversification error:", err);
    res.status(500).json({ error: "Failed to diversify recipe photos" });
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

router.put("/content-schedule/:date", requireAdmin, async (req, res) => {
  const { date } = req.params;
  const entry = req.body as ContentBatchEntry;

  if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    return res.status(400).json({ error: `Invalid date: ${entry.date}` });
  }

  if (entry.date !== date) {
    return res.status(400).json({ error: "Date in URL must match date in body" });
  }

  await pool.query(
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
  );

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

// Public: feed of the admin's notes visible now (scheduled_for <= now or null).
router.get("/notes", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, body, image, created_at, scheduled_for
       FROM loretta_notes
       WHERE COALESCE(scheduled_for, created_at) <= NOW()
       ORDER BY COALESCE(scheduled_for, created_at) DESC LIMIT 50`
    );
    res.json({
      notes: rows.map((row) => ({
        id: String(row.id),
        title: row.title,
        body: row.body,
        image: row.image ?? undefined,
        sentAt: (row.scheduled_for ?? row.created_at).toISOString(),
      })),
    });
  } catch (err) {
    console.error("Fetch notes error:", err);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

// Admin: all notes including future-scheduled ones.
router.get("/notes/admin", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, body, image, created_at, scheduled_for
       FROM loretta_notes
       ORDER BY COALESCE(scheduled_for, created_at) DESC`
    );
    res.json({
      notes: rows.map((row) => ({
        id: String(row.id),
        title: row.title,
        body: row.body,
        image: row.image ?? undefined,
        sentAt: (row.scheduled_for ?? row.created_at).toISOString(),
        scheduledFor: row.scheduled_for ? row.scheduled_for.toISOString() : null,
      })),
    });
  } catch (err) {
    console.error("Fetch admin notes error:", err);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

// Admin: create a note, optionally scheduled for a future time.
router.post("/notes", requireAdmin, async (req, res) => {
  try {
    const { title, body, image, scheduledFor } = req.body as {
      title?: string; body?: string; image?: string; scheduledFor?: string;
    };
    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ error: "Title and body are required" });
    }

    const scheduledAt = scheduledFor ? new Date(scheduledFor) : null;
    const isImmediate = !scheduledAt || scheduledAt <= new Date();

    const { rows } = await pool.query(
      `INSERT INTO loretta_notes (title, body, image, scheduled_for)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, body, image, created_at, scheduled_for`,
      [title.trim(), body.trim(), image || null, scheduledAt]
    );
    const note = rows[0];

    // Only broadcast push notification for immediate (non-future) notes.
    let pushResult;
    if (isImmediate) {
      pushResult = await broadcastNotification({
        title: note.title,
        body: note.body,
        tag: "loretta-note",
        url: "/inspirations",
      });
    }

    res.status(201).json({
      note: {
        id: String(note.id),
        title: note.title,
        body: note.body,
        image: note.image ?? undefined,
        sentAt: (note.scheduled_for ?? note.created_at).toISOString(),
        scheduledFor: note.scheduled_for ? note.scheduled_for.toISOString() : null,
      },
      push: pushResult,
    });
  } catch (err) {
    console.error("Create note error:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

// Admin: edit a note's title and/or body.
router.patch("/notes/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body } = req.body as { title?: string; body?: string };
    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ error: "Title and body are required" });
    }
    const { rows } = await pool.query(
      `UPDATE loretta_notes SET title = $1, body = $2 WHERE id = $3
       RETURNING id, title, body, image, created_at, scheduled_for`,
      [title.trim(), body.trim(), Number(id)]
    );
    if (!rows.length) return res.status(404).json({ error: "Note not found" });
    const note = rows[0];
    res.json({
      id: String(note.id),
      title: note.title,
      body: note.body,
      sentAt: (note.scheduled_for ?? note.created_at).toISOString(),
    });
  } catch (err) {
    console.error("Update note error:", err);
    res.status(500).json({ error: "Failed to update note" });
  }
});

// Admin: delete a note.
router.delete("/notes/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM loretta_notes WHERE id = $1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete note error:", err);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

export default router;
