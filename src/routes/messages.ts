import { Router } from "express";
import { pool } from "../db";
import { sendNotificationToUser } from "../push";
import { deriveMemberId, findEmailByMemberId } from "../utils/memberUtils";

const router = Router();

// Get unread message count by email
// NOTE: this and the other literal-path routes below must stay ahead of the
// "/:userId" wildcard route — otherwise Express matches "/unread-count" as
// userId="unread-count" and the badge fetch always 400s.
router.get("/unread-count", async (req, res) => {
  const email = req.query.email as string;

  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  try {
    // Derive the member ID from email
    const memberId = deriveMemberId(email.toLowerCase());

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as count FROM messages WHERE recipient_id = $1 AND read = false`,
      [memberId]
    );

    res.json({ count: rows[0]?.count || 0 });
  } catch (err) {
    console.error("Fetch unread count error:", err);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// Get unread message count (legacy: by currentUserId)
router.get("/count/unread", async (req, res) => {
  const currentUserId = req.query.currentUserId as string;

  if (!currentUserId) {
    return res.status(400).json({ error: "currentUserId required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as count FROM messages WHERE recipient_id = $1 AND read = false`,
      [currentUserId]
    );

    res.json({ unreadCount: rows[0]?.count || 0 });
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
    // The old version of this query mixed DISTINCT, GROUP BY, and a
    // correlated subquery that referenced ungrouped columns — invalid SQL
    // that Postgres rejected with a 500 on every call, so the inbox always
    // silently fell back to the client's "No conversations yet" placeholder
    // even when real conversations existed (they only showed up if you
    // opened a specific person's thread directly).
    const { rows } = await pool.query(
      `WITH conv AS (
         SELECT
           CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS user_id,
           body,
           created_at,
           (recipient_id = $1 AND read = false) AS is_unread
         FROM messages
         WHERE sender_id = $1 OR recipient_id = $1
       ),
       ranked AS (
         SELECT user_id, body, created_at,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
         FROM conv
       )
       SELECT
         c.user_id,
         r.created_at AS last_message_at,
         r.body AS last_body,
         COUNT(*) FILTER (WHERE c.is_unread) AS unread_count
       FROM conv c
       JOIN ranked r ON r.user_id = c.user_id AND r.rn = 1
       GROUP BY c.user_id, r.created_at, r.body
       ORDER BY r.created_at DESC`,
      [currentUserId]
    );

    res.json({ conversations: rows });
  } catch (err) {
    console.error("Fetch inbox error:", err);
    res.status(500).json({ error: "Failed to fetch inbox" });
  }
});

// Get conversation with a user
router.get("/:userId", async (req, res) => {
  const { userId } = req.params;
  const currentUserId = req.query.currentUserId as string;

  if (!currentUserId) {
    return res.status(400).json({ error: "currentUserId required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, sender_id, recipient_id, body, read, created_at, edited_at, likes, image, image_status
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

// Send a message (text or photo)
router.post("/", async (req, res) => {
  const { senderId, recipientId, body, senderName, image } = req.body as {
    senderId?: string;
    recipientId?: string;
    body?: string;
    senderName?: string;
    image?: string; // base64 data URL for photo messages
  };

  if (!senderId || !recipientId || (!body && !image)) {
    return res.status(400).json({ error: "senderId, recipientId, and body or image required" });
  }

  if (senderId === recipientId) {
    return res.status(400).json({ error: "Cannot message yourself" });
  }

  try {
    // Block check: if recipient has blocked the sender, silently discard
    const { rows: blockRows } = await pool.query(
      `SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [recipientId, senderId]
    );
    if (blockRows.length > 0) {
      return res.status(201).json({ message: { id: -1, sender_id: senderId, recipient_id: recipientId, body: body || "", read: false, created_at: new Date().toISOString() } });
    }

    const messageBody = body || (image ? "📷 Photo" : "");
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, body, image, image_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sender_id, recipient_id, body, read, created_at, image, image_status`,
      [senderId, recipientId, messageBody, image ?? null, image ? "pending" : null]
    );

    const recipientEmail = await findEmailByMemberId(recipientId);
    if (recipientEmail) {
      const deepLinkUrl = `/messages/${encodeURIComponent(senderId)}`;
      const notifBody = image ? "📷 Sent you a photo" : (body || "").substring(0, 100);
      sendNotificationToUser(recipientEmail, {
        title: senderName || "New message",
        body: notifBody,
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

// Edit a message
router.put("/:messageId", async (req, res) => {
  const { body, senderId } = req.body as { body?: string; senderId?: string };
  if (!body || !senderId) {
    return res.status(400).json({ error: "body and senderId required" });
  }

  try {
    const { rows } = await pool.query("SELECT sender_id FROM messages WHERE id = $1", [req.params.messageId]);
    if (rows.length === 0) return res.status(404).json({ error: "Message not found" });
    if (rows[0].sender_id !== senderId) return res.status(403).json({ error: "Can only edit your own messages" });

    await pool.query("UPDATE messages SET body = $1, edited_at = now() WHERE id = $2", [body, req.params.messageId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Edit message error:", err);
    res.status(500).json({ error: "Failed to edit message" });
  }
});

// Approve a photo message (receiver taps to reveal it)
router.patch("/:messageId/approve-image", async (req, res) => {
  const { approverId } = req.body as { approverId?: string };
  if (!approverId) return res.status(400).json({ error: "approverId required" });
  try {
    const { rows } = await pool.query("SELECT recipient_id FROM messages WHERE id = $1", [req.params.messageId]);
    if (rows.length === 0) return res.status(404).json({ error: "Message not found" });
    if (rows[0].recipient_id !== approverId) return res.status(403).json({ error: "Only recipient can approve" });
    await pool.query("UPDATE messages SET image_status = 'approved' WHERE id = $1", [req.params.messageId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Approve image error:", err);
    res.status(500).json({ error: "Failed to approve image" });
  }
});

// Toggle like on a message (add/remove liker's ID from likes array)
router.post("/:messageId/like", async (req, res) => {
  const { userId } = req.body as { userId?: string };
  if (!userId) {
    return res.status(400).json({ error: "userId required" });
  }

  try {
    const { rows } = await pool.query("SELECT likes FROM messages WHERE id = $1", [req.params.messageId]);
    if (rows.length === 0) return res.status(404).json({ error: "Message not found" });

    const currentLikes = rows[0].likes || [];
    const isLiked = currentLikes.includes(userId);
    const updatedLikes = isLiked
      ? currentLikes.filter((id: string) => id !== userId)
      : [...currentLikes, userId];

    await pool.query("UPDATE messages SET likes = $1 WHERE id = $2", [updatedLikes, req.params.messageId]);
    res.json({ liked: !isLiked });
  } catch (err) {
    console.error("Like message error:", err);
    res.status(500).json({ error: "Failed to toggle like" });
  }
});

export default router;
