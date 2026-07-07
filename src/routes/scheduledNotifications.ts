import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

router.get("/notifications/scheduled", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, title, body, send_at FROM scheduled_notifications WHERE sent = FALSE ORDER BY send_at ASC"
    );
    res.json({ scheduled: rows });
  } catch (err) {
    console.error("Fetch scheduled notifications error:", err);
    res.status(500).json({ error: "Failed to fetch scheduled notifications" });
  }
});

router.post("/notifications/scheduled", requireAdmin, async (req, res) => {
  const { title, body, sendAt } = req.body as { title?: string; body?: string; sendAt?: string };
  if (!title?.trim() || !body?.trim() || !sendAt) {
    return res.status(400).json({ error: "title, body, and sendAt are required" });
  }
  const sendAtDate = new Date(sendAt);
  if (isNaN(sendAtDate.getTime()) || sendAtDate <= new Date()) {
    return res.status(400).json({ error: "sendAt must be a valid future datetime" });
  }
  try {
    const { rows } = await pool.query(
      "INSERT INTO scheduled_notifications (title, body, send_at) VALUES ($1, $2, $3) RETURNING id, title, body, send_at",
      [title.trim(), body.trim(), sendAtDate.toISOString()]
    );
    res.status(201).json({ notification: rows[0] });
  } catch (err) {
    console.error("Schedule notification error:", err);
    res.status(500).json({ error: "Failed to schedule notification" });
  }
});

router.put("/notifications/scheduled/:id", requireAdmin, async (req, res) => {
  const { title, body, sendAt } = req.body as { title?: string; body?: string; sendAt?: string };
  if (!title?.trim() || !body?.trim() || !sendAt) {
    return res.status(400).json({ error: "title, body, and sendAt are required" });
  }
  const sendAtDate = new Date(sendAt);
  if (isNaN(sendAtDate.getTime())) {
    return res.status(400).json({ error: "sendAt must be a valid datetime" });
  }
  try {
    const { rows } = await pool.query(
      "UPDATE scheduled_notifications SET title = $1, body = $2, send_at = $3 WHERE id = $4 AND sent = FALSE RETURNING id, title, body, send_at",
      [title.trim(), body.trim(), sendAtDate.toISOString(), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Notification not found or already sent" });
    res.json({ notification: rows[0] });
  } catch (err) {
    console.error("Update scheduled notification error:", err);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

router.delete("/notifications/scheduled/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM scheduled_notifications WHERE id = $1 AND sent = FALSE", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete scheduled notification error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});

export default router;
