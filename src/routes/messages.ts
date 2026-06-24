import { Router } from "express";
import { pool } from "../db";
import { sendNotificationToUser } from "../push";

const router = Router();

// Mirrors deriveMemberId() in members.ts/AppContext.tsx. Message sender/
// recipient ids are always derived member ids (e.g. "m_8vwxqg"), never raw
// emails, so push notifications need this to resolve an id back to the
// email that push_subscriptions are keyed on.
function deriveMemberId(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return `m_${Math.abs(hash).toString(36)}`;
}

async function findEmailByMemberId(memberId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT email FROM members");
  for (const row of rows) {
    if (deriveMemberId(row.email) === memberId) return row.email;
  }
  return null;
}

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

    // Send push notification to recipient. recipientId is always a derived
    // member id (e.g. "m_8vwxqg"), never an email, so it must be resolved
    // against the members table to find the email push_subscriptions is
    // keyed on — checking recipientId.includes("@") here always failed,
    // which is why DM push notifications never actually sent.
    const recipientEmail = await findEmailByMemberId(recipientId);
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
