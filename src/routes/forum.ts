import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { broadcastNotification } from "../push";

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
      `SELECT id, category_id, title, author_id, author_name, author_avatar, created_at
       FROM forum_threads ORDER BY created_at DESC`
    );
    const { rows: messageRows } = await pool.query(
      `SELECT id, thread_id, author_id, author_name, author_avatar, text, created_at, likes, reply_to_id
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
      messages: messagesByThread.get(row.id) ?? [],
    }));

    res.json({ threads });
  } catch (err) {
    console.error("Fetch threads error:", err);
    res.status(500).json({ error: "Failed to fetch threads" });
  }
});

router.post("/threads", async (req, res) => {
  const { id, categoryId, title, authorId, authorName, authorAvatar, text, messageId } = req.body as {
    id: string;
    categoryId: string;
    title: string;
    authorId: string;
    authorName: string;
    authorAvatar?: string;
    text: string;
    messageId: string;
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
      `INSERT INTO forum_messages (id, thread_id, author_id, author_name, author_avatar, text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [messageId, id, authorId, authorName, authorAvatar || null, text]
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
  const { id, authorId, authorName, authorAvatar, text, replyToId } = req.body as {
    id: string;
    authorId: string;
    authorName: string;
    authorAvatar?: string;
    text: string;
    replyToId?: string;
  };

  if (!id || !authorId || !text) {
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
      `INSERT INTO forum_messages (id, thread_id, author_id, author_name, author_avatar, text, reply_to_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, req.params.threadId, authorId, authorName, authorAvatar || null, text, replyToId || null]
    );

    // Send push notification to all members about the new community message
    // Deep link to the specific thread
    const deepLinkUrl = categoryId ? `/community/${categoryId}/${req.params.threadId}` : "/community";
    broadcastNotification({
      title: `${authorName} posted in ${threadTitle}`,
      body: text.substring(0, 100),
      tag: "community",
      url: deepLinkUrl,
    }).catch((err) => console.error("Failed to send community notification:", err));

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

export default router;
