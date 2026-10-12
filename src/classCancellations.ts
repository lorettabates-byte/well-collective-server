import { pool } from "./db";
import { ADMIN_NOTIFY_EMAIL, ADMIN_NOTIFY_EMAILS, sendNotificationToUser, type NotificationPayload } from "./push";
import { getPaidMembers, isExcludedAccount } from "./paidMembers";

// Class cancellations: a banner in the app plus two pushes per cancelled class.
//   week: 7 days before at 10:00 AM Eastern (or right away if that has passed)
//   eve:  the evening before at 6:00 PM Eastern, pointing at a replacement class
// Nothing is ever sent once the class time has passed. Recipients are paying
// members and people on a current free trial, never lapsed trials.

const TZ = "America/New_York";
const WEEK_AT = "10:00";
const EVE_AT = "18:00";
export const PUSH_TAG = "class-cancellation";

export type PushKind = "week" | "eve";

export interface Cancellation {
  date: string; // YYYY-MM-DD, the cancelled class
  time: string; // HH:MM Eastern
  back_on: string; // YYYY-MM-DD, the next class
  back_time: string; // HH:MM Eastern
  replacement: { title: string; url: string } | null;
}

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// "2026-11-10" -> "Tuesday, November 10"
export function formatDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
}

// "09:00" -> "9:00", "18:30" -> "6:30 PM"
export function formatClock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")}${h >= 12 ? " PM" : ""}`;
}

export function bannerText(c: Cancellation): string {
  return `No class or livestream on ${formatDay(c.date)}. Back ${formatDay(c.back_on)} at ${formatClock(c.back_time)}.`;
}

export function buildPush(kind: PushKind, c: Cancellation): NotificationPayload {
  const back = formatDay(c.back_on);
  if (kind === "week") {
    return {
      title: `No class ${formatDay(c.date)}`,
      body: `Heads up! There's no class or livestream on ${formatDay(c.date)}. We're back together ${back} at ${formatClock(c.back_time)}. I'll miss you!`,
      tag: PUSH_TAG,
      url: "/",
    };
  }
  if (c.replacement) {
    return {
      title: "No class tomorrow, but you can still dance!",
      body: `Do ${c.replacement.title} anytime in the library. See you ${back}!`,
      tag: PUSH_TAG,
      url: c.replacement.url,
    };
  }
  return {
    title: "No class tomorrow, but you can still dance!",
    body: `Pick any class in the library and dance with me anyway! See you ${back}.`,
    tag: PUSH_TAG,
    url: "/videos",
  };
}

interface PlannedPush {
  kind: PushKind;
  send_at: Date | null; // null = skipped
  reason?: string;
}

// When each push should go out, worked out in Postgres so daylight saving is right.
export async function planPushes(c: Cancellation): Promise<PlannedPush[]> {
  const { rows } = await pool.query<{ week_at: Date; eve_at: Date; class_at: Date; now: Date }>(
    `SELECT (($1::date - 7) + $3::time) AT TIME ZONE '${TZ}' AS week_at,
            (($1::date - 1) + $4::time) AT TIME ZONE '${TZ}' AS eve_at,
            ($1::date + $2::time) AT TIME ZONE '${TZ}' AS class_at,
            now() AS now`,
    [c.date, c.time, WEEK_AT, EVE_AT]
  );
  const { week_at, eve_at, class_at, now } = rows[0];
  if (class_at <= now) {
    return [
      { kind: "week", send_at: null, reason: "class time has passed" },
      { kind: "eve", send_at: null, reason: "class time has passed" },
    ];
  }
  const week: PlannedPush = { kind: "week", send_at: week_at > now ? week_at : now };
  const eve: PlannedPush = eve_at > now && eve_at < class_at
    ? { kind: "eve", send_at: eve_at }
    : { kind: "eve", send_at: null, reason: "the evening before has already passed" };
  return [week, eve];
}

function rowToCancellation(row: {
  date: Date | string; class_time: string; back_on: Date | string; back_time: string;
  replacement_title: string | null; replacement_url: string | null;
}): Cancellation {
  const day = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  return {
    date: day(row.date),
    time: row.class_time,
    back_on: day(row.back_on),
    back_time: row.back_time,
    replacement: row.replacement_title && row.replacement_url
      ? { title: row.replacement_title, url: row.replacement_url }
      : null,
  };
}

export async function getCancellation(date: string): Promise<Cancellation | null> {
  const { rows } = await pool.query("SELECT * FROM class_cancellations WHERE date = $1", [date]);
  return rows[0] ? rowToCancellation(rows[0]) : null;
}

// Classes whose day hasn't ended yet in Eastern time (banner shows until then).
export async function listUpcoming(): Promise<Cancellation[]> {
  const { rows } = await pool.query(
    `SELECT * FROM class_cancellations
      WHERE date >= (now() AT TIME ZONE '${TZ}')::date
      ORDER BY date ASC`
  );
  return rows.map(rowToCancellation);
}

export async function isClassCancelled(date: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM class_cancellations WHERE date = $1", [date]);
  return rows.length > 0;
}

export interface SavedPush {
  kind: PushKind;
  send_at: string;
  status: string;
  sent_at?: string | null;
  sent_count?: number | null;
}

// Upsert. Pushes already sent for this date are never sent again; anything still
// pending is rebuilt from the new details.
export async function saveCancellation(c: Cancellation): Promise<{
  scheduled: SavedPush[];
  already_sent: SavedPush[];
  skipped: { kind: PushKind; reason: string }[];
}> {
  const plan = await planPushes(c);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO class_cancellations (date, class_time, back_on, back_time, replacement_title, replacement_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (date) DO UPDATE SET
         class_time = EXCLUDED.class_time, back_on = EXCLUDED.back_on, back_time = EXCLUDED.back_time,
         replacement_title = EXCLUDED.replacement_title, replacement_url = EXCLUDED.replacement_url,
         updated_at = now()`,
      [c.date, c.time, c.back_on, c.back_time, c.replacement?.title ?? null, c.replacement?.url ?? null]
    );
    // Lock this date's push rows so a scheduler tick can't claim one mid-save.
    const { rows: existing } = await client.query<{ kind: PushKind; status: string; send_at: Date; sent_at: Date | null; sent_count: number | null }>(
      `SELECT kind, status, send_at, sent_at, sent_count FROM class_cancellation_pushes
        WHERE class_date = $1 AND status IN ('pending', 'sending', 'sent') FOR UPDATE`,
      [c.date]
    );
    const done = existing.filter((r) => r.status === "sent" || r.status === "sending");
    const doneKinds = new Set(done.map((r) => r.kind));
    await client.query("DELETE FROM class_cancellation_pushes WHERE class_date = $1 AND status = 'pending'", [c.date]);

    const scheduled: SavedPush[] = [];
    const skipped: { kind: PushKind; reason: string }[] = [];
    for (const p of plan) {
      if (doneKinds.has(p.kind)) continue;
      if (!p.send_at) {
        skipped.push({ kind: p.kind, reason: p.reason ?? "not needed" });
        continue;
      }
      const payload = buildPush(p.kind, c);
      await client.query(
        `INSERT INTO class_cancellation_pushes (class_date, kind, send_at, title, body, url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.date, p.kind, p.send_at, payload.title, payload.body, payload.url]
      );
      scheduled.push({ kind: p.kind, send_at: p.send_at.toISOString(), status: "pending" });
    }
    await client.query("COMMIT");
    return {
      scheduled,
      skipped,
      already_sent: done.map((r) => ({
        kind: r.kind, send_at: r.send_at.toISOString(), status: r.status,
        sent_at: r.sent_at?.toISOString() ?? null, sent_count: r.sent_count,
      })),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Removes the banner and stops anything not yet sent. Sent rows stay as the log.
export async function removeCancellation(date: string): Promise<{ removed: boolean; cancelled_pushes: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount: cancelled } = await client.query(
      `UPDATE class_cancellation_pushes SET status = 'cancelled', note = 'cancellation removed'
        WHERE class_date = $1 AND status = 'pending'`,
      [date]
    );
    const { rowCount: removed } = await client.query("DELETE FROM class_cancellations WHERE date = $1", [date]);
    await client.query("COMMIT");
    return { removed: (removed ?? 0) > 0, cancelled_pushes: cancelled ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Push log for the Command Center: recent and upcoming cancellations with
// every push row, including ones whose cancellation was later removed.
export async function listWithLog(): Promise<unknown[]> {
  const { rows: cancellations } = await pool.query(
    `SELECT * FROM class_cancellations
      WHERE date >= (now() AT TIME ZONE '${TZ}')::date - 60
      ORDER BY date ASC`
  );
  const { rows: pushes } = await pool.query(
    `SELECT class_date, kind, status, send_at, sent_at, eligible_count, sent_count, device_count, title, body, url, note
       FROM class_cancellation_pushes
      WHERE class_date >= (now() AT TIME ZONE '${TZ}')::date - 60
      ORDER BY class_date ASC, send_at ASC`
  );
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const dates = new Set<string>([...cancellations.map((r) => day(r.date)), ...pushes.map((p) => day(p.class_date))]);
  return [...dates].sort().map((date) => {
    const row = cancellations.find((r) => day(r.date) === date);
    const c = row ? rowToCancellation(row) : null;
    return {
      date,
      active: !!c,
      ...(c ? { time: c.time, back_on: c.back_on, back_time: c.back_time, replacement: c.replacement, banner: bannerText(c) } : {}),
      pushes: pushes.filter((p) => day(p.class_date) === date).map((p) => ({
        kind: p.kind,
        status: p.status,
        send_at: p.send_at?.toISOString() ?? null,
        sent_at: p.sent_at?.toISOString() ?? null,
        eligible_count: p.eligible_count,
        sent_count: p.sent_count,
        device_count: p.device_count,
        title: p.title,
        body: p.body,
        url: p.url,
        note: p.note,
      })),
    };
  });
}

// Everyone with a push subscription or app device who is paying or on a
// current free trial. Throws if the paid list can't be loaded, so the caller
// retries instead of guessing.
export async function eligibleRecipients(): Promise<string[]> {
  const paid = await getPaidMembers();
  const { rows } = await pool.query<{ user_email: string; trial: boolean }>(
    `SELECT t.user_email, COALESCE(bool_or(m.trial_ends_at >= CURRENT_DATE), false) AS trial
       FROM (SELECT DISTINCT user_email FROM device_tokens
             UNION
             SELECT DISTINCT user_email FROM push_subscriptions WHERE user_email IS NOT NULL) t
       LEFT JOIN members m ON lower(m.email) = lower(t.user_email)
      GROUP BY t.user_email`
  );
  return rows
    .filter((r) => {
      const e = r.user_email.toLowerCase();
      return r.trial
        || paid.website.has(e)
        || paid.apple.has(e)
        || ADMIN_NOTIFY_EMAILS.includes(e)
        || isExcludedAccount(e); // Loretta's family and team comp accounts
    })
    .map((r) => r.user_email);
}

async function sendToAll(emails: string[], payload: NotificationPayload): Promise<{ members: number; devices: number }> {
  let members = 0;
  let devices = 0;
  for (let i = 0; i < emails.length; i += 10) {
    const results = await Promise.all(
      emails.slice(i, i + 10).map((e) =>
        sendNotificationToUser(e, payload).catch((err) => {
          console.error(`[CLASS CANCEL] Push to ${e} failed:`, err);
          return { sent: 0, removed: 0, blocked: 0 };
        })
      )
    );
    for (const r of results) {
      if (r.sent > 0) members += 1;
      devices += r.sent;
    }
  }
  return { members, devices };
}

let running = false;

// Called every minute by the scheduler, and right after a save so an
// immediate push doesn't wait for the next tick.
export async function processDueClassCancellationPushes(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await pool.query(
      `UPDATE class_cancellation_pushes p SET status = 'skipped', note = 'class time passed before it was sent'
         FROM class_cancellations c
        WHERE p.class_date = c.date AND p.status = 'pending'
          AND (c.date + c.class_time::time) AT TIME ZONE '${TZ}' <= now()`
    );
    const { rows: due } = await pool.query<{ id: number; class_date: Date; kind: PushKind; title: string; body: string; url: string }>(
      `UPDATE class_cancellation_pushes SET status = 'sending'
        WHERE id IN (
          SELECT p.id FROM class_cancellation_pushes p
            JOIN class_cancellations c ON c.date = p.class_date
           WHERE p.status = 'pending' AND p.send_at <= now()
             AND (c.date + c.class_time::time) AT TIME ZONE '${TZ}' > now()
           ORDER BY p.send_at
           FOR UPDATE OF p SKIP LOCKED)
        RETURNING id, class_date, kind, title, body, url`
    );
    if (due.length === 0) return;

    let recipients: string[];
    try {
      recipients = await eligibleRecipients();
    } catch (err) {
      console.error("[CLASS CANCEL] Could not load the member list, will retry next minute:", err);
      await pool.query(
        `UPDATE class_cancellation_pushes SET status = 'pending', note = 'member list unavailable, retrying'
          WHERE id = ANY($1::int[])`,
        [due.map((d) => d.id)]
      );
      return;
    }

    for (const push of due) {
      const payload: NotificationPayload = { title: push.title, body: push.body, url: push.url, tag: PUSH_TAG };
      const { members, devices } = await sendToAll(recipients, payload);
      await pool.query(
        `UPDATE class_cancellation_pushes
            SET status = 'sent', sent_at = now(), eligible_count = $2, sent_count = $3, device_count = $4, note = NULL
          WHERE id = $1`,
        [push.id, recipients.length, members, devices]
      );
      console.log(
        `[CLASS CANCEL] ${push.kind} push for ${push.class_date.toISOString().slice(0, 10)} sent to ${members} of ${recipients.length} members (${devices} devices)`
      );
    }
  } finally {
    running = false;
  }
}

// Test mode: both pushes go to Loretta's own account right now. Nothing is
// saved, so no banner appears and no member gets anything.
export async function sendTest(c: Cancellation): Promise<{
  sent_to: string;
  pushes: { kind: PushKind; title: string; body: string; url?: string; devices_reached: number }[];
}> {
  const out = [];
  for (const kind of ["week", "eve"] as PushKind[]) {
    const payload = buildPush(kind, c);
    const r = await sendNotificationToUser(ADMIN_NOTIFY_EMAIL, payload);
    out.push({ kind, title: payload.title, body: payload.body, url: payload.url, devices_reached: r.sent });
  }
  return { sent_to: ADMIN_NOTIFY_EMAIL, pushes: out };
}
