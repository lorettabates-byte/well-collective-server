import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { broadcastNotification } from "../push";

const router = Router();

const TIMEZONE = process.env.SCHEDULE_TIMEZONE || "America/New_York";

interface SongInput {
  title: string;
  artist?: string;
  url: string;
  lyrics?: string;
  sortOrder?: number;
  categoryIds?: number[];
}

// 5pm Monday in the configured timezone, on or after `from`. Used both to
// find the first open Music Monday slot and to add a week to the last
// queued one, so the FIFO queue always lands on a Monday regardless of
// what day an admin actually uploads on.
const RELEASE_HOUR = 17; // 5pm

function nextMonday5pm(from: Date): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(from);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const dayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const today = dayIndex[weekday ?? "Mon"] ?? 1;

  let daysUntilMonday = (1 - today + 7) % 7;
  // If it's already Monday but past the release hour, push to next week rather than firing immediately.
  if (daysUntilMonday === 0 && hour >= RELEASE_HOUR) daysUntilMonday = 7;

  const result = new Date(from);
  result.setUTCDate(result.getUTCDate() + daysUntilMonday);
  // Setting an exact time-in-timezone instant without a date library: figure
  // out the UTC offset for that timezone on that date and apply it.
  const offsetFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    timeZoneName: "shortOffset",
  });
  const offsetPart = offsetFormatter.formatToParts(result).find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const offsetMatch = offsetPart.match(/GMT([+-]\d+)/);
  const offsetHours = offsetMatch ? Number(offsetMatch[1]) : 0;

  result.setUTCHours(RELEASE_HOUR - offsetHours, 0, 0, 0);
  return result;
}

async function computeNextReleaseSlot(): Promise<Date> {
  const { rows } = await pool.query(
    `SELECT MAX(release_at) as max_release FROM songs WHERE release_at IS NOT NULL AND release_at > now()`
  );
  const maxRelease = rows[0]?.max_release as Date | null;
  if (maxRelease) {
    return new Date(maxRelease.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return nextMonday5pm(new Date());
}

function formatSong(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist ?? undefined,
    url: row.url,
    lyrics: row.lyrics ?? undefined,
    sortOrder: row.sort_order,
    categoryIds: (row.category_ids as number[] | null) ?? [],
    releaseAt: row.release_at ? (row.release_at as Date).toISOString() : undefined,
    featured: row.featured ?? false,
  };
}

const SONG_SELECT = `
  SELECT s.id, s.title, s.artist, s.url, s.lyrics, s.sort_order, s.release_at,
    COALESCE(array_agg(scl.category_id) FILTER (WHERE scl.category_id IS NOT NULL), '{}') AS category_ids,
    (s.release_at IS NOT NULL AND s.release_at <= now() AND s.release_at > now() - interval '7 days') AS featured
  FROM songs s
  LEFT JOIN song_category_links scl ON scl.song_id = s.id
`;

router.get("/songs", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `${SONG_SELECT}
       WHERE s.release_at IS NULL OR s.release_at <= now()
       GROUP BY s.id
       ORDER BY s.sort_order ASC, s.id ASC`
    );
    res.json({ songs: rows.map(formatSong) });
  } catch (err) {
    console.error("Fetch songs error:", err);
    res.status(500).json({ error: "Failed to fetch songs" });
  }
});

// Admin view of the upcoming Music Monday queue — songs not yet visible to
// members, in release order.
router.get("/songs/queue", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `${SONG_SELECT}
       WHERE s.release_at IS NOT NULL AND s.release_at > now()
       GROUP BY s.id
       ORDER BY s.release_at ASC`
    );
    res.json({ songs: rows.map(formatSong) });
  } catch (err) {
    console.error("Fetch song queue error:", err);
    res.status(500).json({ error: "Failed to fetch song queue" });
  }
});

// Reorder the Music Monday queue — takes the new order of song IDs and
// reassigns the existing scheduled Monday dates to them in that order,
// so the first ID in the array gets the earliest Monday, etc.
router.put("/songs/queue/reorder", requireAdmin, async (req, res) => {
  const { ids } = req.body as { ids?: number[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array required" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT release_at FROM songs WHERE id = ANY($1) AND release_at IS NOT NULL AND release_at > now() ORDER BY release_at ASC`,
      [ids]
    );
    const dates = rows.map((r) => r.release_at as Date);
    if (dates.length !== ids.length) {
      return res.status(400).json({ error: "Some songs are not in the queue" });
    }
    for (let i = 0; i < ids.length; i++) {
      await pool.query("UPDATE songs SET release_at = $1 WHERE id = $2", [dates[i], ids[i]]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Reorder queue error:", err);
    res.status(500).json({ error: "Failed to reorder queue" });
  }
});

// Skips the queue entirely and makes a song visible right now, firing the
// "new song" push immediately instead of waiting for the hourly check to
// notice it — for releasing a song the same day rather than next Monday.
router.post("/songs/:id/release-now", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE songs SET release_at = now() WHERE id = $1 RETURNING id, title`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Song not found" });

    const song = rows[0];
    try {
      await broadcastNotification({
        title: "🎵 New Song!",
        body: `"${song.title}" just dropped on the WELL Collective Playlist.`,
        tag: "new-song",
        url: "/music",
      });
      await pool.query(`UPDATE songs SET notified_at = now() WHERE id = $1`, [song.id]);
    } catch (notifyErr) {
      console.error(`Failed to send release-now notification for song ${song.id}:`, notifyErr);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Release song now error:", err);
    res.status(500).json({ error: "Failed to release song" });
  }
});

router.post("/songs", requireAdmin, async (req, res) => {
  const { title, artist, url, lyrics, sortOrder, categoryIds } = req.body as SongInput;

  if (!title || !url) {
    return res.status(400).json({ error: "Title and url are required" });
  }

  try {
    const releaseAt = await computeNextReleaseSlot();
    const { rows } = await pool.query(
      `INSERT INTO songs (title, artist, url, lyrics, sort_order, release_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, artist, url, lyrics, sort_order, release_at`,
      [title, artist || null, url, lyrics || null, sortOrder ?? 0, releaseAt]
    );
    const row = rows[0];

    if (Array.isArray(categoryIds) && categoryIds.length > 0) {
      await Promise.all(
        categoryIds.map((categoryId) =>
          pool.query(
            `INSERT INTO song_category_links (song_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [row.id, categoryId]
          )
        )
      );
    }

    res.status(201).json({
      song: formatSong({ ...row, category_ids: categoryIds ?? [], featured: false }),
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
       RETURNING id, title, artist, url, lyrics, sort_order, release_at`,
      [title, artist || null, url, lyrics || null, sortOrder ?? 0, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Song not found" });
    }
    res.json({ song: formatSong({ ...rows[0], category_ids: [], featured: false }) });
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
       RETURNING id, title, artist, url, lyrics, sort_order, release_at`,
      [lyrics || null, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Song not found" });
    }
    res.json({ song: formatSong({ ...rows[0], category_ids: [], featured: false }) });
  } catch (err) {
    console.error("Update song lyrics error:", err);
    res.status(500).json({ error: "Failed to update song lyrics" });
  }
});

// Replaces this song's category links entirely with the given set.
router.put("/songs/:id/categories", requireAdmin, async (req, res) => {
  const { categoryIds } = req.body as { categoryIds?: number[] };
  if (!Array.isArray(categoryIds)) {
    return res.status(400).json({ error: "categoryIds array required" });
  }

  try {
    await pool.query("DELETE FROM song_category_links WHERE song_id = $1", [req.params.id]);
    await Promise.all(
      categoryIds.map((categoryId) =>
        pool.query(
          `INSERT INTO song_category_links (song_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [req.params.id, categoryId]
        )
      )
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Set song categories error:", err);
    res.status(500).json({ error: "Failed to set song categories" });
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

router.get("/song-categories", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, name, sort_order FROM song_categories ORDER BY sort_order ASC, id ASC");
    res.json({ categories: rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order })) });
  } catch (err) {
    console.error("Fetch song categories error:", err);
    res.status(500).json({ error: "Failed to fetch song categories" });
  }
});

router.post("/song-categories", requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });

  try {
    const { rows: countRows } = await pool.query("SELECT COUNT(*) AS count FROM song_categories");
    const { rows } = await pool.query(
      `INSERT INTO song_categories (name, sort_order) VALUES ($1, $2) RETURNING id, name, sort_order`,
      [name.trim(), Number(countRows[0].count)]
    );
    res.status(201).json({ category: { id: rows[0].id, name: rows[0].name, sortOrder: rows[0].sort_order } });
  } catch (err) {
    console.error("Create song category error:", err);
    res.status(500).json({ error: "Failed to create song category — name may already exist" });
  }
});

router.put("/song-categories/:id", requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });

  try {
    const { rows } = await pool.query(
      `UPDATE song_categories SET name = $1 WHERE id = $2 RETURNING id, name, sort_order`,
      [name.trim(), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Category not found" });
    res.json({ category: { id: rows[0].id, name: rows[0].name, sortOrder: rows[0].sort_order } });
  } catch (err) {
    console.error("Rename song category error:", err);
    res.status(500).json({ error: "Failed to rename song category — name may already exist" });
  }
});

router.delete("/song-categories/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM song_categories WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete song category error:", err);
    res.status(500).json({ error: "Failed to delete song category" });
  }
});

export default router;
