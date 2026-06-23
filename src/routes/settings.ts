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

export default router;
