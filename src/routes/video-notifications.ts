import { Router } from "express";
import { pool } from "../db";
import { broadcastNotification } from "../push";

const router = Router();

const VIDEO_API_URL = "https://lorettabates.com/videolibrary.lorettabates.com/wp-json/wp/v2/wpstream_product_vod?per_page=10";

interface WpVideo {
  id: number;
  link: string;
  date: string;
  title: { rendered: string };
  excerpt: { rendered: string };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

async function fetchLatestVideos(): Promise<WpVideo[]> {
  try {
    const res = await fetch(VIDEO_API_URL);
    if (!res.ok) return [];
    const videos = await res.json();
    return Array.isArray(videos) ? videos : [];
  } catch {
    return [];
  }
}

async function checkAndNotifyNewVideos(): Promise<void> {
  try {
    const videos = await fetchLatestVideos();
    if (videos.length === 0) return;

    for (const video of videos) {
      const videoId = `video-${video.id}`;
      const publishedAt = new Date(video.date);

      const { rows } = await pool.query(
        "SELECT notified_at FROM published_content WHERE id = $1",
        [videoId]
      );

      if (rows.length === 0) {
        // New video — insert and notify
        const title = stripHtml(video.title.rendered);
        const description = stripHtml(video.excerpt.rendered).slice(0, 180);

        await pool.query(
          `INSERT INTO published_content (id, type, title, link, published_at, notified_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (id) DO UPDATE SET notified_at = now()`,
          [videoId, "video", title, video.link, publishedAt]
        );

        await broadcastNotification(
          {
            title: `New Class: ${title}`,
            body: description,
            tag: "new-video",
            url: "/classes",
          },
          { contentPublishedAt: publishedAt }
        );

        console.log(`[VIDEO] Sent notification for new video: "${title}"`);
      } else if (!rows[0]?.notified_at) {
        // Already in DB but not notified yet — notify it
        const title = stripHtml(video.title.rendered);
        const description = stripHtml(video.excerpt.rendered).slice(0, 180);

        await pool.query("UPDATE published_content SET notified_at = now() WHERE id = $1", [videoId]);

        await broadcastNotification(
          {
            title: `New Class: ${title}`,
            body: description,
            tag: "new-video",
            url: "/classes",
          },
          { contentPublishedAt: publishedAt }
        );

        console.log(`[VIDEO] Sent notification for video: "${title}"`);
      }
    }
  } catch (err) {
    console.error("[VIDEO] Failed to check/notify videos:", err);
  }
}

// Manual endpoint for admin to trigger video check
router.post("/send-video-notification", async (req, res) => {
  try {
    await checkAndNotifyNewVideos();
    res.json({ ok: true, message: "Videos checked. New classes will send notifications automatically." });
  } catch (err) {
    console.error("[VIDEO] Error in send-video-notification endpoint:", err);
    res.status(500).json({ error: "Failed to send notifications" });
  }
});

// Export for use in scheduler
export async function checkForNewVideos(): Promise<void> {
  await checkAndNotifyNewVideos();
}

export default router;
