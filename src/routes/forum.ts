import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { broadcastNotification, sendNotificationToUser } from "../push";
import { awardPoints } from "./points";
import { extractMentions } from "../utils/mentions";

const router = Router();

interface MessageRow {
  id: string;
  author_id: string;
  author_name: string;
  author_avatar: string | null;
  text: string;
  created_at: Date;
  likes: string[];
  reply_to_id: string | null;
  image: string | null;
}

function formatMessage(row: MessageRow) {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar ?? "",
    text: row.text,
    createdAt: row.created_at.toISOString(),
    likes: row.likes,
    replyToId: row.reply_to_id ?? undefined,
    image: row.image ?? undefined,
  };
}

router.get("/categories", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, description, icon, color FROM forum_categories ORDER BY sort_order ASC"
    );
    res.json({ categories: rows });
  } catch (err) {
    console.error("Fetch categories error:", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

router.post("/categories", requireAdmin, async (req, res) => {
  const { id, name, description, icon, color, sortOrder } = req.body as {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    sortOrder?: number;
  };
  if (!id || !name) return res.status(400).json({ error: "id and name required" });

  try {
    await pool.query(
      `INSERT INTO forum_categories (id, name, description, icon, color, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET name = $2, description = $3, icon = $4, color = $5, sort_order = $6`,
      [id, name, description || null, icon || null, color || null, sortOrder ?? 0]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Create category error:", err);
    res.status(500).json({ error: "Failed to create category" });
  }
});

router.delete("/categories/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM forum_categories WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete category error:", err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

router.get("/threads", async (_req, res) => {
  try {
    const { rows: threadRows } = await pool.query(
      `SELECT id, category_id, title, author_id, author_name, author_avatar, created_at, pinned_at
       FROM forum_threads ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC, created_at DESC`
    );
    const { rows: messageRows } = await pool.query(
      `SELECT id, thread_id, author_id, author_name, author_avatar, text, created_at, likes, reply_to_id, image
       FROM forum_messages ORDER BY created_at ASC`
    );

    const messagesByThread = new Map<string, ReturnType<typeof formatMessage>[]>();
    for (const row of messageRows) {
      const list = messagesByThread.get(row.thread_id) ?? [];
      list.push(formatMessage(row));
      messagesByThread.set(row.thread_id, list);
    }

    const threads = threadRows.map((row) => ({
      id: row.id,
      categoryId: row.category_id,
      title: row.title,
      authorId: row.author_id,
      authorName: row.author_name,
      authorAvatar: row.author_avatar ?? "",
      createdAt: row.created_at.toISOString(),
      pinnedAt: row.pinned_at?.toISOString() ?? undefined,
      messages: messagesByThread.get(row.id) ?? [],
    }));

    res.json({ threads });
  } catch (err) {
    console.error("Fetch threads error:", err);
    res.status(500).json({ error: "Failed to fetch threads" });
  }
});

router.post("/threads", async (req, res) => {
  const { id, categoryId, title, authorId, authorName, authorAvatar, authorEmail, text, messageId, image } = req.body as {
    id: string;
    categoryId: string;
    title: string;
    authorId: string;
    authorName: string;
    authorAvatar?: string;
    authorEmail?: string;
    text: string;
    messageId: string;
    image?: string;
  };

  if (!id || !categoryId || !title || !authorId || !text || !messageId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await pool.query(
      `INSERT INTO forum_threads (id, category_id, title, author_id, author_name, author_avatar)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, categoryId, title, authorId, authorName, authorAvatar || null]
    );
    await pool.query(
      `INSERT INTO forum_messages (id, thread_id, author_id, author_name, author_avatar, text, image)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [messageId, id, authorId, authorName, authorAvatar || null, text, image || null]
    );

    // Send push notification to all members about the new thread. Replies to
    // existing threads already notify via the /messages route below — new
    // threads need the same treatment, otherwise starting a post never
    // notifies anyone.
    broadcastNotification({
      title: `${authorName} posted in ${title}`,
      body: text.substring(0, 100),
      tag: "community",
      url: `/community/${categoryId}/${id}`,
    }).catch((err) => console.error("Failed to send community notification:", err));

    if (authorEmail) {
      awardPoints(authorEmail.toLowerCase(), "forum_post", { threadId: id })
        .catch((err) => console.error("Award points (forum_post) error:", err));
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Create thread error:", err);
    res.status(500).json({ error: "Failed to create thread" });
  }
});

router.delete("/threads/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM forum_threads WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete thread error:", err);
    res.status(500).json({ error: "Failed to delete thread" });
  }
});

router.post("/threads/:threadId/messages", async (req, res) => {
  const { id, authorId, authorName, authorAvatar, authorEmail, text, replyToId, image } = req.body as {
    id: string;
    authorId: string;
    authorName: string;
    authorAvatar?: string;
    authorEmail?: string;
    text: string;
    replyToId?: string;
    image?: string;
  };

  if (!id || !authorId || (!text && !image)) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Get thread title and category for notification deep link
    const { rows: threadRows } = await pool.query(
      "SELECT title, category_id FROM forum_threads WHERE id = $1",
      [req.params.threadId]
    );
    const threadTitle = threadRows[0]?.title || "New message";
    const categoryId = threadRows[0]?.category_id;

    await pool.query(
      `INSERT INTO forum_messages (id, thread_id, author_id, author_name, author_avatar, text, reply_to_id, image)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, req.params.threadId, authorId, authorName, authorAvatar || null, text || "", replyToId || null, image || null]
    );

    // Deep link to the specific message within the thread so tapping the
    // notification scrolls straight to the reply, not just the thread top.
    const deepLinkUrl = categoryId
      ? `/community/${categoryId}/${req.params.threadId}?message=${id}`
      : "/community";
    broadcastNotification({
      title: `${authorName} posted in ${threadTitle}`,
      body: text ? text.substring(0, 100) : "📷 Shared a photo",
      tag: "community",
      url: deepLinkUrl,
    }).catch((err) => console.error("Failed to send community notification:", err));

    // Handle @mentions — extract usernames and send notifications to mentioned users
    if (text) {
      const mentionedUsernames = extractMentions(text);
      if (mentionedUsernames.length > 0) {
        try {
          // Get user emails for mentioned usernames
          const { rows: mentionedUsers } = await pool.query(
            `SELECT id, email FROM members WHERE name = ANY($1::text[])`,
            [mentionedUsernames]
          );

          for (const mentionedUser of mentionedUsers) {
            if (mentionedUser.email === authorEmail) continue; // Don't notify self

            // Check if user has mention notifications enabled
            const { rows: settingsRows } = await pool.query(
              `SELECT mentions FROM notification_settings WHERE member_email = $1`,
              [mentionedUser.email]
            );

            const mentionsEnabled = settingsRows.length === 0 || settingsRows[0].mentions !== false;
            if (mentionsEnabled) {
              sendNotificationToUser(mentionedUser.email, {
                title: `${authorName} mentioned you`,
                body: `in "${threadTitle}" — ${text.substring(0, 80)}`,
                tag: "mention",
                url: deepLinkUrl,
              }).catch((err) => console.error("Failed to send mention notification:", err));
            }
          }
        } catch (err) {
          console.error("Failed to process mentions:", err);
        }
      }
    }

    if (authorEmail) {
      awardPoints(authorEmail.toLowerCase(), "forum_comment", { threadId: req.params.threadId })
        .catch((err) => console.error("Award points (forum_comment) error:", err));
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Create message error:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

router.delete("/threads/:threadId/messages/:messageId", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM forum_messages WHERE id = $1", [req.params.messageId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete message error:", err);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

router.post("/threads/:threadId/messages/:messageId/like", async (req, res) => {
  const { userId } = req.body as { userId?: string };
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const { rows } = await pool.query("SELECT likes FROM forum_messages WHERE id = $1", [req.params.messageId]);
    if (rows.length === 0) return res.status(404).json({ error: "Message not found" });

    const likes: string[] = rows[0].likes || [];
    const hasLiked = likes.includes(userId);
    const updated = hasLiked ? likes.filter((id) => id !== userId) : [...likes, userId];

    await pool.query("UPDATE forum_messages SET likes = $1 WHERE id = $2", [updated, req.params.messageId]);
    res.json({ likes: updated });
  } catch (err) {
    console.error("Toggle like error:", err);
    res.status(500).json({ error: "Failed to toggle like" });
  }
});

router.put("/threads/:threadId/messages/:messageId", async (req, res) => {
  const { text, userId } = req.body as { text?: string; userId?: string };
  if (!text || !userId) return res.status(400).json({ error: "text and userId required" });

  try {
    const { rows } = await pool.query("SELECT author_id FROM forum_messages WHERE id = $1", [req.params.messageId]);
    if (rows.length === 0) return res.status(404).json({ error: "Message not found" });
    if (rows[0].author_id !== userId) return res.status(403).json({ error: "Can only edit your own messages" });

    await pool.query(
      "UPDATE forum_messages SET text = $1, edited_at = now() WHERE id = $2",
      [text, req.params.messageId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Edit message error:", err);
    res.status(500).json({ error: "Failed to edit message" });
  }
});

router.put("/threads/:threadId", async (req, res) => {
  const { title, userId } = req.body as { title?: string; userId?: string };
  if (!title || !userId) return res.status(400).json({ error: "title and userId required" });

  try {
    const { rows } = await pool.query("SELECT author_id FROM forum_threads WHERE id = $1", [req.params.threadId]);
    if (rows.length === 0) return res.status(404).json({ error: "Thread not found" });
    if (rows[0].author_id !== userId) return res.status(403).json({ error: "Can only edit your own threads" });

    await pool.query(
      "UPDATE forum_threads SET title = $1, edited_at = now() WHERE id = $2",
      [title, req.params.threadId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Edit thread error:", err);
    res.status(500).json({ error: "Failed to edit thread" });
  }
});

router.post("/threads/:threadId/pin", requireAdmin, async (req, res) => {
  try {
    const categoryId = req.query.categoryId as string;
    if (!categoryId) return res.status(400).json({ error: "categoryId required" });

    // Check how many posts are already pinned in this category (max 3)
    const { rows: pinnedRows } = await pool.query(
      `SELECT COUNT(*) as count FROM forum_threads WHERE category_id = $1 AND pinned_at IS NOT NULL`,
      [categoryId]
    );

    if (parseInt(pinnedRows[0].count) >= 3) {
      return res.status(400).json({ error: "Maximum 3 pinned posts per category" });
    }

    await pool.query("UPDATE forum_threads SET pinned_at = now() WHERE id = $1", [req.params.threadId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Pin thread error:", err);
    res.status(500).json({ error: "Failed to pin thread" });
  }
});

router.post("/threads/:threadId/unpin", requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE forum_threads SET pinned_at = NULL WHERE id = $1", [req.params.threadId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Unpin thread error:", err);
    res.status(500).json({ error: "Failed to unpin thread" });
  }
});

export default router;
