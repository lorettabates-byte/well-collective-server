import webpush from "web-push";
import { pool } from "./db";
import { verifyMembership } from "./membership";

const LOGO_URL = "https://app.lorettabates.com/icons/notification-icon.png";
const BADGE_URL = "https://app.lorettabates.com/icons/notification-badge.png";
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
    badge: BADGE_URL,
    image: LOGO_URL,
    color: BRAND_COLOR,
    tag: payload.tag,
    url: payload.url || "/",
  });
}

/**
 * Sends a notification to every stored subscription where the user has an active membership.
 * Subscriptions that the push service reports as gone (404/410) are removed.
 */
export async function broadcastNotification(payload: NotificationPayload): Promise<{ sent: number; removed: number; blocked: number }> {
  console.log(`[PUSH] Broadcasting notification: "${payload.title}"`);

  const { rows } = await pool.query<{ endpoint: string; p256dh: string; auth: string; user_email: string | null }>(
    "SELECT endpoint, p256dh, auth, user_email FROM push_subscriptions"
  );

  console.log(`[PUSH] Found ${rows.length} total subscriptions`);

  const body = buildPayload(payload);
  let sent = 0;
  let removed = 0;
  let blocked = 0;

  await Promise.all(
    rows.map(async (row) => {
      // Verify membership if email is available
      if (row.user_email) {
        const isMember = await verifyMembership(row.user_email);
        console.log(`[PUSH] Email: ${row.user_email}, Is Member: ${isMember}`);
        if (!isMember) {
          blocked += 1;
          console.log(`[PUSH] Blocked subscription for ${row.user_email} - not a member`);
          return; // Skip this subscription
        }
      } else {
        console.log(`[PUSH] No email for subscription, allowing notification`);
      }

      const subscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        await webpush.sendNotification(subscription, body);
        sent += 1;
        console.log(`[PUSH] Successfully sent notification`);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
          removed += 1;
          console.log(`[PUSH] Removed expired subscription (${statusCode})`);
        } else {
          console.error("Push send failed:", err);
        }
      }
    })
  );

  console.log(`[PUSH] Summary - Sent: ${sent}, Removed: ${removed}, Blocked: ${blocked}`);
  return { sent, removed, blocked };
}
