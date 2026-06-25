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
 * Sends a notification to a specific user by email.
 * Skips if the user has no active subscription.
 */
export async function sendNotificationToUser(
  email: string,
  payload: NotificationPayload
): Promise<{ sent: number; removed: number; blocked: number }> {
  console.log(`[PUSH] Sending notification to ${email}: "${payload.title}"`);

  const { rows } = await pool.query<{ endpoint: string; p256dh: string; auth: string; user_email: string | null }>(
    "SELECT endpoint, p256dh, auth, user_email FROM push_subscriptions WHERE user_email = $1",
    [email]
  );

  if (rows.length === 0) {
    console.log(`[PUSH] No subscriptions found for ${email}`);
    return { sent: 0, removed: 0, blocked: 0 };
  }

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
        console.log(`[PUSH] Successfully sent notification to ${email}`);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
          removed += 1;
          console.log(`[PUSH] Removed expired subscription for ${email} (${statusCode})`);
        } else {
          console.error("Push send failed:", err);
        }
      }
    })
  );

  console.log(`[PUSH] Summary for ${email} - Sent: ${sent}, Removed: ${removed}`);
  return { sent, removed, blocked: 0 };
}

/**
 * Sends a notification to every stored subscription where the user is a full
 * (non-trial) active member. Subscriptions that the push service reports as
 * gone (404/410) are removed.
 */
export async function broadcastNotification(payload: NotificationPayload): Promise<{ sent: number; removed: number; blocked: number }> {
  console.log(`[PUSH] Broadcasting notification: "${payload.title}"`);

  const { rows } = await pool.query<{ endpoint: string; p256dh: string; auth: string; user_email: string | null }>(
    "SELECT endpoint, p256dh, auth, user_email FROM push_subscriptions"
  );

  console.log(`[PUSH] Found ${rows.length} total subscriptions`);

  // Trial status lives in our own members table, not WordPress, so it's the
  // authoritative source for "still on an active trial" — WP's membership
  // check has no record of trial-only signups at all and can't be relied on
  // to exclude them.
  const { rows: trialRows } = await pool.query<{ email: string }>(
    "SELECT email FROM members WHERE trial_ends_at IS NOT NULL AND trial_ends_at >= CURRENT_DATE"
  );
  const activeTrialEmails = new Set(trialRows.map((r) => r.email.toLowerCase()));

  const body = buildPayload(payload);
  let sent = 0;
  let removed = 0;
  let blocked = 0;

  await Promise.all(
    rows.map(async (row) => {
      // No email on the subscription means we can't verify membership at
      // all — exclude rather than risk sending to a trial user whose
      // subscription was registered before their email was attached.
      if (!row.user_email) {
        blocked += 1;
        console.log(`[PUSH] Blocked subscription with no email`);
        return;
      }

      if (activeTrialEmails.has(row.user_email.toLowerCase())) {
        blocked += 1;
        console.log(`[PUSH] Blocked subscription for ${row.user_email} - active trial member`);
        return;
      }

      const isMember = await verifyMembership(row.user_email);
      console.log(`[PUSH] Email: ${row.user_email}, Is Member: ${isMember}`);
      if (!isMember) {
        blocked += 1;
        console.log(`[PUSH] Blocked subscription for ${row.user_email} - not a member`);
        return; // Skip this subscription
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
