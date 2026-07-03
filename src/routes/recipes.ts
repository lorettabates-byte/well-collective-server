import { Router } from "express";
import { pool } from "../db";

const router = Router();

interface FolderRow {
  id: number;
  name: string;
  created_at: Date;
}

interface SavedRecipeRow {
  id: number;
  folder_id: number | null;
  recipe_date: Date | null;
  recipe: Record<string, unknown>;
  saved_at: Date;
}

router.get("/recipes/folders", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    const { rows } = await pool.query<FolderRow>(
      "SELECT id, name, created_at FROM recipe_folders WHERE member_email = $1 ORDER BY created_at ASC",
      [email]
    );
    res.json({
      folders: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at.toISOString(),
      })),
    });
  } catch (err) {
    console.error("Fetch recipe folders error:", err);
    res.status(500).json({ error: "Failed to fetch folders" });
  }
});

router.post("/recipes/folders", async (req, res) => {
  const { email, name } = req.body as { email?: string; name?: string };
  if (!email || !name?.trim()) return res.status(400).json({ error: "email and name are required" });

  try {
    const { rows } = await pool.query<FolderRow>(
      "INSERT INTO recipe_folders (member_email, name) VALUES ($1, $2) RETURNING id, name, created_at",
      [email.toLowerCase(), name.trim()]
    );
    res.status(201).json({
      folder: { id: rows[0].id, name: rows[0].name, createdAt: rows[0].created_at.toISOString() },
    });
  } catch (err) {
    console.error("Create recipe folder error:", err);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

router.delete("/recipes/folders/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM recipe_folders WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete recipe folder error:", err);
    res.status(500).json({ error: "Failed to delete folder" });
  }
});

router.get("/recipes/saved", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    const { rows } = await pool.query<SavedRecipeRow>(
      "SELECT id, folder_id, recipe_date, recipe, saved_at FROM saved_recipes WHERE member_email = $1 ORDER BY saved_at DESC",
      [email]
    );
    res.json({
      savedRecipes: rows.map((row) => ({
        id: row.id,
        folderId: row.folder_id ?? undefined,
        date: row.recipe_date ? row.recipe_date.toISOString().slice(0, 10) : undefined,
        savedAt: row.saved_at.toISOString(),
        ...row.recipe,
      })),
    });
  } catch (err) {
    console.error("Fetch saved recipes error:", err);
    res.status(500).json({ error: "Failed to fetch saved recipes" });
  }
});

router.post("/recipes/saved", async (req, res) => {
  const { email, recipe, date, folderId } = req.body as {
    email?: string;
    recipe?: Record<string, unknown>;
    date?: string;
    folderId?: number;
  };
  if (!email || !recipe) return res.status(400).json({ error: "email and recipe are required" });

  try {
    const { rows } = await pool.query<SavedRecipeRow>(
      `INSERT INTO saved_recipes (member_email, folder_id, recipe_date, recipe)
       VALUES ($1, $2, $3, $4) RETURNING id, folder_id, recipe_date, recipe, saved_at`,
      [email.toLowerCase(), folderId ?? null, date ?? null, JSON.stringify(recipe)]
    );
    const row = rows[0];
    res.status(201).json({
      savedRecipe: {
        id: row.id,
        folderId: row.folder_id ?? undefined,
        date: row.recipe_date ? row.recipe_date.toISOString().slice(0, 10) : undefined,
        savedAt: row.saved_at.toISOString(),
        ...row.recipe,
      },
    });
  } catch (err) {
    console.error("Save recipe error:", err);
    res.status(500).json({ error: "Failed to save recipe" });
  }
});

router.put("/recipes/saved/:id", async (req, res) => {
  const { folderId } = req.body as { folderId?: number | null };
  try {
    await pool.query("UPDATE saved_recipes SET folder_id = $2 WHERE id = $1", [req.params.id, folderId ?? null]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Move saved recipe error:", err);
    res.status(500).json({ error: "Failed to update saved recipe" });
  }
});

router.delete("/recipes/saved/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM saved_recipes WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete saved recipe error:", err);
    res.status(500).json({ error: "Failed to delete saved recipe" });
  }
});

interface MealPlanRow {
  id: number;
  plan_date: Date;
  meal_type: string;
  recipe: Record<string, unknown>;
}

router.get("/meal-plan", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    const { rows } = await pool.query<MealPlanRow>(
      "SELECT id, plan_date, meal_type, recipe FROM meal_plan_entries WHERE member_email = $1 ORDER BY plan_date ASC, meal_type ASC",
      [email]
    );
    res.json({
      entries: rows.map((row) => ({
        id: row.id,
        planDate: row.plan_date.toISOString().slice(0, 10),
        mealType: row.meal_type,
        recipe: row.recipe,
      })),
    });
  } catch (err) {
    console.error("Fetch meal plan error:", err);
    res.status(500).json({ error: "Failed to fetch meal plan" });
  }
});

// Upsert — replacing an existing recipe for the same date + meal type.
router.post("/meal-plan", async (req, res) => {
  const { email, planDate, mealType, recipe } = req.body as {
    email?: string;
    planDate?: string;
    mealType?: string;
    recipe?: Record<string, unknown>;
  };
  if (!email || !planDate || !mealType || !recipe) {
    return res.status(400).json({ error: "email, planDate, mealType, and recipe are required" });
  }

  try {
    const { rows } = await pool.query<MealPlanRow>(
      `INSERT INTO meal_plan_entries (member_email, plan_date, meal_type, recipe)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_email, plan_date, meal_type) DO UPDATE SET recipe = $4
       RETURNING id, plan_date, meal_type, recipe`,
      [email.toLowerCase(), planDate, mealType, JSON.stringify(recipe)]
    );
    const row = rows[0];
    res.status(201).json({
      entry: { id: row.id, planDate: row.plan_date.toISOString().slice(0, 10), mealType: row.meal_type, recipe: row.recipe },
    });
  } catch (err) {
    console.error("Set meal plan entry error:", err);
    res.status(500).json({ error: "Failed to set meal plan entry" });
  }
});

router.delete("/meal-plan/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM meal_plan_entries WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete meal plan entry error:", err);
    res.status(500).json({ error: "Failed to delete meal plan entry" });
  }
});

export default router;
