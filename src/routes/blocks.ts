import { Router } from "express";
import { pool } from "../db";

const router = Router();

// GET /api/blocks?userId=xxx — list IDs blocked by this user
router.get("/", async (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const { rows } = await pool.query(
      `SELECT blocked_id FROM user_blocks WHERE blocker_id = $1`,
      [userId]
    );
    res.json({ blockedIds: rows.map((r) => r.blocked_id) });
  } catch (err) {
    console.error("Get blocks error:", err);
    res.status(500).json({ error: "Failed to get blocks" });
  }
});

// POST /api/blocks — block a user
router.post("/", async (req, res) => {
  const { blockerId, blockedId } = req.body as { blockerId?: string; blockedId?: string };
  if (!blockerId || !blockedId) return res.status(400).json({ error: "blockerId and blockedId required" });
  if (blockerId === blockedId) return res.status(400).json({ error: "Cannot block yourself" });
  try {
    await pool.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [blockerId, blockedId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Block user error:", err);
    res.status(500).json({ error: "Failed to block user" });
  }
});

// DELETE /api/blocks/:blockedId?blockerId=xxx — unblock
router.delete("/:blockedId", async (req, res) => {
  const blockerId = req.query.blockerId as string;
  const { blockedId } = req.params;
  if (!blockerId) return res.status(400).json({ error: "blockerId required" });
  try {
    await pool.query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [blockerId, blockedId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Unblock user error:", err);
    res.status(500).json({ error: "Failed to unblock user" });
  }
});

export default router;
