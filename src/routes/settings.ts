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

export default router;
