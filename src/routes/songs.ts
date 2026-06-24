import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

interface SongInput {
  title: string;
  artist?: string;
  url: string;
  lyrics?: string;
  sortOrder?: number;
}

router.get("/songs", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, title, artist, url, lyrics, sort_order FROM songs ORDER BY sort_order ASC, id ASC"
    );
    res.json({
      songs: rows.map((row) => ({
        id: row.id,
        title: row.title,
        artist: row.artist ?? undefined,
        url: row.url,
        lyrics: row.lyrics ?? undefined,
        sortOrder: row.sort_order,
      })),
    });
  } catch (err) {
    console.error("Fetch songs error:", err);
    res.status(500).json({ error: "Failed to fetch songs" });
  }
});

router.post("/songs", requireAdmin, async (req, res) => {
  const { title, artist, url, lyrics, sortOrder } = req.body as SongInput;

  if (!title || !url) {
    return res.status(400).json({ error: "Title and url are required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO songs (title, artist, url, lyrics, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, artist, url, lyrics, sort_order`,
      [title, artist || null, url, lyrics || null, sortOrder ?? 0]
    );
    const row = rows[0];
    res.status(201).json({
      song: {
        id: row.id,
        title: row.title,
        artist: row.artist ?? undefined,
        url: row.url,
        lyrics: row.lyrics ?? undefined,
        sortOrder: row.sort_order,
      },
    });
  } catch (err) {
    console.error("Create song error:", err);
    res.status(500).json({ error: "Failed to create song" });
  }
});

// Must be registered before /songs/:id, otherwise Express would match
// "reorder" as an :id value for that route instead.
router.put("/songs/reorder", requireAdmin, async (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array required" });
  }

  try {
    await Promise.all(ids.map((id, index) => pool.query("UPDATE songs SET sort_order = $1 WHERE id = $2", [index, id])));
    res.json({ ok: true });
  } catch (err) {
    console.error("Reorder songs error:", err);
    res.status(500).json({ error: "Failed to reorder songs" });
  }
});

router.put("/songs/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, artist, url, lyrics, sortOrder } = req.body as SongInput;

  try {
    const { rows } = await pool.query(
      `UPDATE songs SET title = $1, artist = $2, url = $3, lyrics = $4, sort_order = $5 WHERE id = $6
       RETURNING id, title, artist, url, lyrics, sort_order`,
      [title, artist || null, url, lyrics || null, sortOrder ?? 0, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Song not found" });
    }
    const row = rows[0];
    res.json({
      song: {
        id: row.id,
        title: row.title,
        artist: row.artist ?? undefined,
        url: row.url,
        lyrics: row.lyrics ?? undefined,
        sortOrder: row.sort_order,
      },
    });
  } catch (err) {
    console.error("Update song error:", err);
    res.status(500).json({ error: "Failed to update song" });
  }
});

// Update just the lyrics for an existing song, without requiring the admin
// UI to resend title/artist/url/sortOrder (those would otherwise need to be
// round-tripped just to attach lyrics to a song added before this feature).
router.put("/songs/:id/lyrics", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { lyrics } = req.body as { lyrics?: string };

  try {
    const { rows } = await pool.query(
      `UPDATE songs SET lyrics = $1 WHERE id = $2
       RETURNING id, title, artist, url, lyrics, sort_order`,
      [lyrics || null, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Song not found" });
    }
    const row = rows[0];
    res.json({
      song: {
        id: row.id,
        title: row.title,
        artist: row.artist ?? undefined,
        url: row.url,
        lyrics: row.lyrics ?? undefined,
        sortOrder: row.sort_order,
      },
    });
  } catch (err) {
    console.error("Update song lyrics error:", err);
    res.status(500).json({ error: "Failed to update song lyrics" });
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
