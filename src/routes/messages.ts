import { Router } from "express";
import { pool } from "../db";
import { sendNotificationToUser } from "../push";

const router = Router();

// Get conversation with a user
router.get("/:userId", async (req, res) => {
  const { userId } = req.params;
  const currentUserId = req.query.currentUserId as string;

  if (!currentUserId) {
    return res.status(400).json({ error: "currentUserId required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, sender_id, recipient_id, body, read, created_at
       FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at ASC`,
      [currentUserId, userId]
    );

    // Mark messages as read
    await pool.query(
      `UPDATE messages SET read = true WHERE recipient_id = $1 AND sender_id = $2`,
      [currentUserId, userId]
    );

    res.json({ messages: rows });
  } catch (err) {
    console.error("Fetch messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Get unread message count
router.get("/count/unread", async (req, res) => {
  const currentUserId = req.query.currentUserId as string;

  if (!currentUserId) {
    return res.status(400).json({ error: "currentUserId required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as count FROM messages WHERE recipient_id = $1 AND read = false`,
      [currentUserId]
    );

    res.json({ unreadCount: parseInt(rows[0].count) });
  } catch (err) {
    console.error("Fetch unread count error:", err);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// Get inbox (conversations summary)
router.get("/", async (req, res) => {
  const currentUserId = req.query.currentUserId as string;

  if (!currentUserId) {
    return res.status(400).json({ error: "currentUserId required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT
        CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END as user_id,
        MAX(created_at) as last_message_at,
        (SELECT body FROM messages m2
         WHERE (m2.sender_id = messages.sender_id AND m2.recipient_id = messages.recipient_id)
         OR (m2.sender_id = messages.recipient_id AND m2.recipient_id = messages.sender_id)
         ORDER BY m2.created_at DESC LIMIT 1) as last_body,
        COUNT(CASE WHEN recipient_id = $1 AND read = false THEN 1 END) as unread_count
       FROM messages
       WHERE sender_id = $1 OR recipient_id = $1
       GROUP BY user_id
       ORDER BY last_message_at DESC`,
      [currentUserId]
    );

    res.json({ conversations: rows });
  } catch (err) {
    console.error("Fetch inbox error:", err);
    res.status(500).json({ error: "Failed to fetch inbox" });
  }
});

// Send a message
router.post("/", async (req, res) => {
  const { senderId, recipientId, body, senderName } = req.body as {
    senderId?: string;
    recipientId?: string;
    body?: string;
    senderName?: string;
  };

  if (!senderId || !recipientId || !body) {
    return res.status(400).json({ error: "senderId, recipientId, and body required" });
  }

  if (senderId === recipientId) {
    return res.status(400).json({ error: "Cannot message yourself" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1, $2, $3)
       RETURNING id, sender_id, recipient_id, body, read, created_at`,
      [senderId, recipientId, body]
    );

    // Send push notification to recipient. Try to get their email from the
    // recipient ID (which is typically the member email in this system).
    // Recipient ID might be a user ID or email; if it looks like an email, use it.
    const recipientEmail = recipientId.includes("@") ? recipientId : null;
    if (recipientEmail) {
      // Deep link to the specific message conversation with the sender
      const deepLinkUrl = `/messages/${encodeURIComponent(senderId)}`;
      sendNotificationToUser(recipientEmail, {
        title: senderName || "New message",
        body: body.substring(0, 100),
        tag: "message",
        url: deepLinkUrl,
      }).catch((err) => console.error("Failed to send message notification:", err));
    }

    res.status(201).json({ message: rows[0] });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
