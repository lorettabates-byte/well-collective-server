import webpush from "web-push";
import { pool } from "./db";
import { verifyMembership } from "./membership";

const LOGO_URL = "https://app.lorettabates.com/icons/notification-icon-v2.png";
const BADGE_URL = "https://app.lorettabates.com/icons/notification-badge-v2.png";
const BRAND_COLOR = "#0191CE";

// Matches the frontend's FOUNDER_EMAIL (AppContext.tsx) — the single account
// that gets admin-only notifications like "a new user joined".
export const ADMIN_NOTIFY_EMAIL = (process.env.ADMIN_NOTIFY_EMAIL || "loretta@lorettabates.com").toLowerCase();

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
 * Sends a notification to every stored subscription belonging to a full
 * member or a member on an active free trial. Subscriptions that the push
 * service reports as gone (404/410) are removed.
 *
 * Pass `contentPublishedAt` for content-driven notifications (new blog post,
 * class, or event) so members who joined AFTER that content already existed
 * don't get a notification about something that predates them — only members
 * who joined before/at that point in time are eligible.
 */
export async function broadcastNotification(
  payload: NotificationPayload,
  options?: { contentPublishedAt?: Date }
): Promise<{ sent: number; removed: number; blocked: number }> {
  console.log(`[PUSH] Broadcasting notification: "${payload.title}"`);

  const { rows } = await pool.query<{ endpoint: string; p256dh: string; auth: string; user_email: string | null }>(
    "SELECT endpoint, p256dh, auth, user_email FROM push_subscriptions"
  );

  console.log(`[PUSH] Found ${rows.length} total subscriptions`);

  // Trial-only signups have no WordPress account, so the WP membership-status
  // check below always reports them as inactive. Our own members table is the
  // only place that knows they're on an active trial, so check it first and
  // let them through without ever hitting the WP check.
  const { rows: trialRows } = await pool.query<{ email: string }>(
    "SELECT email FROM members WHERE trial_ends_at IS NOT NULL AND trial_ends_at >= CURRENT_DATE"
  );
  const activeTrialEmails = new Set(trialRows.map((r) => r.email.toLowerCase()));

  let joinedAfterContentEmails = new Set<string>();
  if (options?.contentPublishedAt) {
    const { rows: lateJoinerRows } = await pool.query<{ email: string }>(
      "SELECT email FROM members WHERE created_at > $1",
      [options.contentPublishedAt]
    );
    joinedAfterContentEmails = new Set(lateJoinerRows.map((r) => r.email.toLowerCase()));
  }

  const body = buildPayload(payload);
  let sent = 0;
  let removed = 0;
  let blocked = 0;

  await Promise.all(
    rows.map(async (row) => {
      if (!row.user_email) {
        blocked += 1;
        console.log(`[PUSH] Blocked subscription with no email`);
        return;
      }

      if (joinedAfterContentEmails.has(row.user_email.toLowerCase())) {
        blocked += 1;
        console.log(`[PUSH] Blocked subscription for ${row.user_email} - joined after this content was published`);
        return;
      }

      const isActiveTrial = activeTrialEmails.has(row.user_email.toLowerCase());
      if (!isActiveTrial) {
        const isMember = await verifyMembership(row.user_email);
        console.log(`[PUSH] Email: ${row.user_email}, Is Member: ${isMember}`);
        if (!isMember) {
          blocked += 1;
          console.log(`[PUSH] Blocked subscription for ${row.user_email} - not a member`);
          return; // Skip this subscription
        }
      } else {
        console.log(`[PUSH] Email: ${row.user_email} is an active trial member, allowing`);
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
