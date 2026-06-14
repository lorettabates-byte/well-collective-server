import webpush from "web-push";
import { pool } from "./db";

const LOGO_URL = "https://lorettabates.com/wp-content/uploads/2025/11/WELL-Logo-white.png";
const BRAND_COLOR = "#0191CE";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:loretta@lorettabates.com",
  process.env.VAPID_PUBLIC_KEY || "",
  process.env.VAPID_PRIVATE_KEY || ""
);

export interface NotificationPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

function buildPayload(payload: NotificationPayload): string {
  return JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: LOGO_URL,
    badge: LOGO_URL,
    image: LOGO_URL,
    color: BRAND_COLOR,
    tag: payload.tag,
    url: payload.url || "/",
  });
}

/**
 * Sends a notification to every stored subscription. Subscriptions that the
 * push service reports as gone (404/410) are removed.
 */
export async function broadcastNotification(payload: NotificationPayload): Promise<{ sent: number; removed: number }> {
  const { rows } = await pool.query<{ endpoint: string; p256dh: string; auth: string }>(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions"
  );

  const body = buildPayload(payload);
  let sent = 0;
  let removed = 0;

  await Promise.all(
    rows.map(async (row) => {
      const subscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        await webpush.sendNotification(subscription, body);
        sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
          removed += 1;
        } else {
          console.error("Push send failed:", err);
        }
      }
    })
  );

  return { sent, removed };
}
