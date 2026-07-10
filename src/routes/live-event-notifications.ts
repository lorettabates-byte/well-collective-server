import { Router } from "express";
import { pool } from "../db";
import { broadcastNotification } from "../push";

const router = Router();

// Mirrors the frontend's useEventsFeed.ts — same Tribe Events Calendar feed,
// just checked from the backend so a new event on lorettabates.com can
// trigger a push notification the same way a new blog post or class does.
const LIVE_EVENTS_API_URL = "https://lorettabates.com/wp-json/tribe/events/v1/events?per_page=25";

interface TribeEvent {
  id: number;
  title: string;
  description: string;
  url: string;
  start_date: string;
  end_date?: string;
  cost?: string;
  venue?: { venue?: string; city?: string; state?: string };
  image?: { url?: string; sizes?: { medium?: { url?: string } } } | false;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchLiveEvents(): Promise<TribeEvent[]> {
  try {
    const res = await fetch(LIVE_EVENTS_API_URL);
    if (!res.ok) return [];
    const data = (await res.json()) as { events?: TribeEvent[] };
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    return [];
  }
}

async function checkAndNotifyNewLiveEvents(): Promise<void> {
  try {
    const events = await fetchLiveEvents();
    if (events.length === 0) return;

    for (const event of events) {
      const eventId = `live-event-${event.id}`;
      const publishedAt = new Date(event.start_date);

      const { rows } = await pool.query("SELECT notified_at FROM published_content WHERE id = $1", [eventId]);

      if (rows.length === 0) {
        const title = stripHtml(event.title);
        const location = [event.venue?.venue, event.venue?.city, event.venue?.state].filter(Boolean).join(", ");
        const description = location || stripHtml(event.description).slice(0, 180);

        await pool.query(
          `INSERT INTO published_content (id, type, title, link, published_at, notified_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (id) DO UPDATE SET notified_at = now()`,
          [eventId, "live-event", title, event.url, publishedAt]
        );

        await broadcastNotification(
          {
            title: `New Event: ${title}`,
            body: description,
            tag: "new-event",
            url: "/events",
          },
          { contentPublishedAt: publishedAt }
        );

        console.log(`[LIVE-EVENT] Sent notification for new event: "${title}"`);
      } else if (!rows[0]?.notified_at) {
        const title = stripHtml(event.title);
        const location = [event.venue?.venue, event.venue?.city, event.venue?.state].filter(Boolean).join(", ");
        const description = location || stripHtml(event.description).slice(0, 180);

        await pool.query("UPDATE published_content SET notified_at = now() WHERE id = $1", [eventId]);

        await broadcastNotification(
          {
            title: `New Event: ${title}`,
            body: description,
            tag: "new-event",
            url: "/events",
          },
          { contentPublishedAt: publishedAt }
        );

        console.log(`[LIVE-EVENT] Sent notification for event: "${title}"`);
      }
    }
  } catch (err) {
    console.error("[LIVE-EVENT] Failed to check/notify live events:", err);
  }
}

router.post("/send-live-event-notification", async (_req, res) => {
  try {
    await checkAndNotifyNewLiveEvents();
    res.json({ ok: true, message: "Live events checked and notifications sent" });
  } catch (err) {
    console.error("[LIVE-EVENT] Error in send-live-event-notification endpoint:", err);
    res.status(500).json({ error: "Failed to send notifications" });
  }
});

router.get("/", async (_req, res) => {
  try {
    const events = await fetchLiveEvents();
    res.json({ events });
  } catch (err) {
    console.error("[LIVE-EVENT] Failed to fetch live events:", err);
    res.status(500).json({ error: "Failed to fetch live events" });
  }
});

export async function checkForNewLiveEvents(): Promise<void> {
  await checkAndNotifyNewLiveEvents();
}

export default router;
