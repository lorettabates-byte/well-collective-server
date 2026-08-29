import { Router } from "express";
import { pool } from "../db";
import { sendNotificationToUser } from "../push";

const router = Router();

router.get("/notifications/inbox", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, type, title, body, link, read_at, created_at
       FROM member_notifications
       WHERE member_email = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [email]
    );

    res.json({
      notifications: rows.map((row) => ({
        id: Number(row.id),
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
        read: !!row.read_at,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      })),
    });
  } catch (err) {
    console.error("Fetch member notifications error:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.post("/notifications/:id/read", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    await pool.query(
      `UPDATE member_notifications
       SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND member_email = $2`,
      [req.params.id, email.toLowerCase()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Mark notification read error:", err);
    res.status(500).json({ error: "Failed to mark notification read" });
  }
});

router.post("/notifications/read-all", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    await pool.query(
      `UPDATE member_notifications
       SET read_at = COALESCE(read_at, now())
       WHERE member_email = $1 AND read_at IS NULL`,
      [email.toLowerCase()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Mark all notifications read error:", err);
    res.status(500).json({ error: "Failed to mark notifications read" });
  }
});

router.post("/notifications/send-game-invite", async (req, res) => {
  const { recipientId, inviterName, gameName, challengeId } = req.body as {
    recipientId?: string;
    inviterName?: string;
    gameName?: string;
    challengeId?: string;
  };

  if (!recipientId || !inviterName || !gameName) {
    return res.status(400).json({ error: "recipientId, inviterName, and gameName are required" });
  }

  try {
    // Look up the recipient's email by ID
    const { rows } = await pool.query<{ email: string }>(
      "SELECT email FROM members WHERE id = $1",
      [recipientId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const recipientEmail = rows[0].email;
    const challengeUrl = challengeId ? `/wellness?tab=activities&challenge=${challengeId}` : "/wellness";

    // Send the push notification
    await sendNotificationToUser(recipientEmail, {
      title: `${inviterName} invited you to challenge your brains together!`,
      body: `Play ${gameName} and earn points together for being part of the tribe.`,
      tag: "game-invite",
      url: challengeUrl,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Send game invite notification error:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

export default router;
