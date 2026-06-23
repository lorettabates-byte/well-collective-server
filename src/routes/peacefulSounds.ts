import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

interface PeacefulSoundInput {
  title: string;
  emoji?: string;
  url: string;
  sortOrder?: number;
}

router.get("/peaceful-sounds", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, title, emoji, url, sort_order FROM peaceful_sounds ORDER BY sort_order ASC, id ASC"
    );
    res.json({
      sounds: rows.map((row) => ({
        id: row.id,
        title: row.title,
        emoji: row.emoji,
        url: row.url,
        sortOrder: row.sort_order,
      })),
    });
  } catch (err) {
    console.error("Fetch peaceful sounds error:", err);
    res.status(500).json({ error: "Failed to fetch peaceful sounds" });
  }
});

router.post("/peaceful-sounds", requireAdmin, async (req, res) => {
  const { title, emoji, url, sortOrder } = req.body as PeacefulSoundInput;

  if (!title || !url) {
    return res.status(400).json({ error: "Title and url are required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO peaceful_sounds (title, emoji, url, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, emoji, url, sort_order`,
      [title, emoji || "🎵", url, sortOrder ?? 0]
    );
    const row = rows[0];
    res.status(201).json({
      sound: { id: row.id, title: row.title, emoji: row.emoji, url: row.url, sortOrder: row.sort_order },
    });
  } catch (err) {
    console.error("Create peaceful sound error:", err);
    res.status(500).json({ error: "Failed to create peaceful sound" });
  }
});

// Must be registered before /peaceful-sounds/:id, otherwise Express would
// match "reorder" as an :id value for that route instead.
router.put("/peaceful-sounds/reorder", requireAdmin, async (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array required" });
  }

  try {
    await Promise.all(
      ids.map((id, index) => pool.query("UPDATE peaceful_sounds SET sort_order = $1 WHERE id = $2", [index, id]))
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Reorder peaceful sounds error:", err);
    res.status(500).json({ error: "Failed to reorder peaceful sounds" });
  }
});

router.delete("/peaceful-sounds/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM peaceful_sounds WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete peaceful sound error:", err);
    res.status(500).json({ error: "Failed to delete peaceful sound" });
  }
});

export default router;
