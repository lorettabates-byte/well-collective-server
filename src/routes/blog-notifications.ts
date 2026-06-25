import { Router } from "express";
import { pool } from "../db";
import { broadcastNotification } from "../push";

const router = Router();

const BLOG_API_URL = "https://lorettabates.com/videolibrary.lorettabates.com/wp-json/wp/v2/posts?_embed&per_page=10";

interface WpPost {
  id: number;
  link: string;
  date: string;
  title: { rendered: string };
  excerpt: { rendered: string };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

async function fetchLatestBlogPosts(): Promise<WpPost[]> {
  try {
    const res = await fetch(BLOG_API_URL);
    if (!res.ok) return [];
    const posts = await res.json();
    return Array.isArray(posts) ? posts : [];
  } catch {
    return [];
  }
}

async function checkAndNotifyNewBlogPosts(): Promise<void> {
  try {
    const posts = await fetchLatestBlogPosts();
    if (posts.length === 0) return;

    for (const post of posts) {
      const postId = `blog-${post.id}`;
      const publishedAt = new Date(post.date);

      const { rows } = await pool.query(
        "SELECT notified_at FROM published_content WHERE id = $1",
        [postId]
      );

      if (rows.length === 0) {
        // New post — insert and notify
        const title = stripHtml(post.title.rendered);
        const description = stripHtml(post.excerpt.rendered).slice(0, 180);

        await pool.query(
          `INSERT INTO published_content (id, type, title, link, published_at, notified_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (id) DO UPDATE SET notified_at = now()`,
          [postId, "blog", title, post.link, publishedAt]
        );

        await broadcastNotification({
          title: `New Blog Post: ${title}`,
          body: description,
          tag: "blog-post",
          url: "/blog",
        });

        console.log(`[BLOG] Sent notification for new post: "${title}"`);
      } else if (!rows[0]?.notified_at) {
        // Already in DB but not notified yet — notify it
        const title = stripHtml(post.title.rendered);
        const description = stripHtml(post.excerpt.rendered).slice(0, 180);

        await pool.query("UPDATE published_content SET notified_at = now() WHERE id = $1", [postId]);

        await broadcastNotification({
          title: `New Blog Post: ${title}`,
          body: description,
          tag: "blog-post",
          url: "/blog",
        });

        console.log(`[BLOG] Sent notification for post: "${title}"`);
      }
    }
  } catch (err) {
    console.error("[BLOG] Failed to check/notify blog posts:", err);
  }
}

// Manual endpoint for admin to trigger blog post notification
router.post("/send-blog-notification", async (req, res) => {
  try {
    await checkAndNotifyNewBlogPosts();
    res.json({ ok: true, message: "Blog posts checked and notifications sent" });
  } catch (err) {
    console.error("[BLOG] Error in send-blog-notification endpoint:", err);
    res.status(500).json({ error: "Failed to send notifications" });
  }
});

// Export for use in scheduler
export async function checkForNewBlogPosts(): Promise<void> {
  await checkAndNotifyNewBlogPosts();
}

export default router;
