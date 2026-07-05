import { Router } from "express";
import { pool } from "../db";

const router = Router();

interface SavedMeal {
  id: number;
  name: string;
  mealType: string;
  estimatedCalories?: number;
  estimatedProteinG?: number;
  estimatedCarbsG?: number;
  estimatedFatG?: number;
  createdAt: string;
}

// Get saved meals for a member
router.get("/meals/saved", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, name, meal_type, estimated_calories, estimated_protein_g, estimated_carbs_g, estimated_fat_g, created_at
       FROM saved_meals
       WHERE member_email = $1
       ORDER BY created_at DESC`,
      [email]
    );
    res.json({
      saved: rows.map((row) => ({
        id: row.id,
        name: row.name,
        mealType: row.meal_type,
        estimatedCalories: row.estimated_calories,
        estimatedProteinG: row.estimated_protein_g,
        estimatedCarbsG: row.estimated_carbs_g,
        estimatedFatG: row.estimated_fat_g,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    console.error("Fetch saved meals error:", err);
    res.status(500).json({ error: "Failed to fetch saved meals" });
  }
});

// Save a meal
router.post("/meals/saved", async (req, res) => {
  const { email, name, mealType, estimatedCalories, estimatedProteinG, estimatedCarbsG, estimatedFatG } = req.body as {
    email?: string;
    name?: string;
    mealType?: string;
    estimatedCalories?: number;
    estimatedProteinG?: number;
    estimatedCarbsG?: number;
    estimatedFatG?: number;
  };

  if (!email || !name?.trim() || !mealType) {
    return res.status(400).json({ error: "email, name, and mealType are required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO saved_meals (member_email, name, meal_type, estimated_calories, estimated_protein_g, estimated_carbs_g, estimated_fat_g)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (member_email, name, meal_type) DO UPDATE SET
         estimated_calories = $4,
         estimated_protein_g = $5,
         estimated_carbs_g = $6,
         estimated_fat_g = $7
       RETURNING id, name, meal_type, estimated_calories, estimated_protein_g, estimated_carbs_g, estimated_fat_g, created_at`,
      [email.toLowerCase(), name.trim(), mealType, estimatedCalories || null, estimatedProteinG || null, estimatedCarbsG || null, estimatedFatG || null]
    );

    const row = rows[0];
    res.status(201).json({
      saved: {
        id: row.id,
        name: row.name,
        mealType: row.meal_type,
        estimatedCalories: row.estimated_calories,
        estimatedProteinG: row.estimated_protein_g,
        estimatedCarbsG: row.estimated_carbs_g,
        estimatedFatG: row.estimated_fat_g,
        createdAt: row.created_at,
      },
    });
  } catch (err) {
    console.error("Save meal error:", err);
    res.status(500).json({ error: "Failed to save meal" });
  }
});

// Delete a saved meal
router.delete("/meals/saved/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM saved_meals WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete saved meal error:", err);
    res.status(500).json({ error: "Failed to delete saved meal" });
  }
});

export default router;
