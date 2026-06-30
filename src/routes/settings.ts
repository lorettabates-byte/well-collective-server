import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

router.get("/settings/featured-event", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'featuredEventId'");
    res.json({ featuredEventId: rows[0]?.value ?? null });
  } catch (err) {
    console.error("Fetch featured event error:", err);
    res.status(500).json({ error: "Failed to fetch featured event" });
  }
});

router.put("/settings/featured-event", requireAdmin, async (req, res) => {
  const { featuredEventId } = req.body as { featuredEventId: string | null };

  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('featuredEventId', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [featuredEventId || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Update featured event error:", err);
    res.status(500).json({ error: "Failed to update featured event" });
  }
});

// Live events come from the lorettabates.com WordPress feed and have no row
// in our own `events` table, so "sold out" for them can't be a column —
// instead we keep a flat list of sold-out event ids (mixing local event ids
// and "live-<wpId>" ids) under one settings key.
router.get("/settings/sold-out-events", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'soldOutEventIds'");
    const ids = rows[0]?.value ? JSON.parse(rows[0].value) : [];
    res.json({ ids });
  } catch (err) {
    console.error("Fetch sold-out events error:", err);
    res.status(500).json({ error: "Failed to fetch sold-out events" });
  }
});

router.put("/settings/sold-out-events", requireAdmin, async (req, res) => {
  const { ids } = req.body as { ids?: string[] };

  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('soldOutEventIds', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(ids || [])]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Update sold-out events error:", err);
    res.status(500).json({ error: "Failed to update sold-out events" });
  }
});

// The 10 built-in peaceful sounds are hardcoded in the app's code, not the
// database, so "deleting" one just means hiding its id from members here.
router.get("/settings/hidden-sounds", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'hiddenBuiltinSounds'");
    const hidden = rows[0]?.value ? JSON.parse(rows[0].value) : [];
    res.json({ hidden });
  } catch (err) {
    console.error("Fetch hidden sounds error:", err);
    res.status(500).json({ error: "Failed to fetch hidden sounds" });
  }
});

router.put("/settings/hidden-sounds", requireAdmin, async (req, res) => {
  const { hidden } = req.body as { hidden: string[] };

  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('hiddenBuiltinSounds', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(hidden || [])]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Update hidden sounds error:", err);
    res.status(500).json({ error: "Failed to update hidden sounds" });
  }
});

router.get("/settings/livestream-cover", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'livestreamCoverUrl'");
    res.json({ url: rows[0]?.value || null });
  } catch (err) {
    console.error("Fetch livestream cover error:", err);
    res.status(500).json({ error: "Failed to fetch livestream cover" });
  }
});

router.put("/settings/livestream-cover", requireAdmin, async (req, res) => {
  const { url } = req.body as { url: string | null };

  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('livestreamCoverUrl', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [url || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Update livestream cover error:", err);
    res.status(500).json({ error: "Failed to update livestream cover" });
  }
});

router.get("/settings/content-restrictions", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'contentRestrictions'");
    const restrictions = rows[0]?.value ? JSON.parse(rows[0].value) : { lockedCategories: [], lockedSongIds: [] };
    res.json(restrictions);
  } catch (err) {
    console.error("Fetch content restrictions error:", err);
    res.status(500).json({ error: "Failed to fetch content restrictions" });
  }
});

router.put("/settings/content-restrictions", requireAdmin, async (req, res) => {
  const { lockedCategories, lockedSongIds } = req.body as { lockedCategories?: string[]; lockedSongIds?: number[] };

  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('contentRestrictions', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify({ lockedCategories: lockedCategories || [], lockedSongIds: lockedSongIds || [] })]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Update content restrictions error:", err);
    res.status(500).json({ error: "Failed to update content restrictions" });
  }
});

// Upcoming (today or later) cancellations, for the admin panel to display.
router.get("/settings/livestream-cancellations", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT date, reason FROM livestream_cancellations WHERE date >= CURRENT_DATE ORDER BY date ASC`
    );
    res.json({
      cancellations: rows.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        reason: row.reason ?? undefined,
      })),
    });
  } catch (err) {
    console.error("Fetch livestream cancellations error:", err);
    res.status(500).json({ error: "Failed to fetch livestream cancellations" });
  }
});

router.post("/settings/livestream-cancellations", requireAdmin, async (req, res) => {
  const { date, reason } = req.body as { date?: string; reason?: string };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date is required in yyyy-mm-dd format" });
  }

  try {
    await pool.query(
      `INSERT INTO livestream_cancellations (date, reason) VALUES ($1, $2)
       ON CONFLICT (date) DO UPDATE SET reason = $2`,
      [date, reason?.trim() || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Create livestream cancellation error:", err);
    res.status(500).json({ error: "Failed to schedule cancellation" });
  }
});

router.delete("/settings/livestream-cancellations/:date", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM livestream_cancellations WHERE date = $1", [req.params.date]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete livestream cancellation error:", err);
    res.status(500).json({ error: "Failed to remove cancellation" });
  }
});

export default router;
