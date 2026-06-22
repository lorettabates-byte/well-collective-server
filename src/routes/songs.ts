import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

interface SongInput {
  title: string;
  artist?: string;
  url: string;
  sortOrder?: number;
}

router.get("/songs", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, title, artist, url, sort_order FROM songs ORDER BY sort_order ASC, id ASC"
    );
    res.json({
      songs: rows.map((row) => ({
        id: row.id,
        title: row.title,
        artist: row.artist ?? undefined,
        url: row.url,
        sortOrder: row.sort_order,
      })),
    });
  } catch (err) {
    console.error("Fetch songs error:", err);
    res.status(500).json({ error: "Failed to fetch songs" });
  }
});

router.post("/songs", requireAdmin, async (req, res) => {
  const { title, artist, url, sortOrder } = req.body as SongInput;

  if (!title || !url) {
    return res.status(400).json({ error: "Title and url are required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO songs (title, artist, url, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, artist, url, sort_order`,
      [title, artist || null, url, sortOrder ?? 0]
    );
    const row = rows[0];
    res.status(201).json({
      song: { id: row.id, title: row.title, artist: row.artist ?? undefined, url: row.url, sortOrder: row.sort_order },
    });
  } catch (err) {
    console.error("Create song error:", err);
    res.status(500).json({ error: "Failed to create song" });
  }
});

router.put("/songs/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, artist, url, sortOrder } = req.body as SongInput;

  try {
    const { rows } = await pool.query(
      `UPDATE songs SET title = $1, artist = $2, url = $3, sort_order = $4 WHERE id = $5
       RETURNING id, title, artist, url, sort_order`,
      [title, artist || null, url, sortOrder ?? 0, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Song not found" });
    }
    const row = rows[0];
    res.json({
      song: { id: row.id, title: row.title, artist: row.artist ?? undefined, url: row.url, sortOrder: row.sort_order },
    });
  } catch (err) {
    console.error("Update song error:", err);
    res.status(500).json({ error: "Failed to update song" });
  }
});

router.delete("/songs/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM songs WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete song error:", err);
    res.status(500).json({ error: "Failed to delete song" });
  }
});

export default router;
