import { pool } from "./db";
import type { AppleSub } from "./revenuecat";
import { getPaidMembers, isExcludedAccount } from "./paidMembers";
import { renderWinBackEmail, firstNameFrom } from "./emailTemplates";
import { sendOutreachEmail } from "./brevo";

const WP_BASE = "https://lorettabates.com/videolibrary.lorettabates.com/wp-json/well/v1";
const DAY = 86_400_000;
// Send a week after access ends; the 7-day spread lets a missed night catch up.
const SEND_AFTER_DAYS = 7;
const SEND_UNTIL_DAYS = 14;
// A longer-term member can get the offer again on a later cancellation, but not within this gap.
const REPEAT_GAP_DAYS = 180;

let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  tablesReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS apple_subscriptions (
        email TEXT PRIMARY KEY,
        first_seen_at TIMESTAMPTZ,
        last_seen_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        period_ends_at TIMESTAMPTZ,
        will_renew BOOLEAN,
        ended_at TIMESTAMPTZ
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS winback_log (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        source TEXT NOT NULL,
        paid_months INT NOT NULL,
        ended_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  })();
  return tablesReady;
}

/**
 * Called after every successful RevenueCat read. Records live Apple subscribers, adds any
 * the app database doesn't know yet, and marks the ones that disappeared as ended.
 */
export async function syncAppleSubscribers(subs: Map<string, AppleSub>): Promise<void> {
  await ensureTables();
  for (const [email, sub] of subs) {
    await pool.query(
      `INSERT INTO apple_subscriptions (email, first_seen_at, last_seen_active_at, period_ends_at, will_renew, ended_at)
       VALUES ($1, $2, now(), $3, $4, NULL)
       ON CONFLICT (email) DO UPDATE SET
         first_seen_at = COALESCE(apple_subscriptions.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_active_at = now(), period_ends_at = EXCLUDED.period_ends_at,
         will_renew = EXCLUDED.will_renew, ended_at = NULL`,
      [email, sub.firstSeenAt ? new Date(sub.firstSeenAt) : null, sub.endsAt ? new Date(sub.endsAt) : null, sub.willRenew]
    );
    await pool.query(
      `INSERT INTO members (email, name, membership_status, membership_source)
       VALUES ($1, $2, 'active', 'iap_apple')
       ON CONFLICT (email) DO NOTHING`,
      [email, email.split("@")[0]]
    );
  }
  // No longer live in RevenueCat: ended when the last known paid period ran out.
  await pool.query(
    `UPDATE apple_subscriptions
       SET ended_at = COALESCE(period_ends_at, last_seen_active_at)
     WHERE ended_at IS NULL AND NOT (email = ANY($1))`,
    [[...subs.keys()]]
  );
}

interface Candidate { email: string; name: string; source: "website" | "apple"; paidMonths: number; endedAt: Date }

async function websiteLapsed(): Promise<Candidate[]> {
  const res = await fetch(`${WP_BASE}/lapsed-members?days=${SEND_UNTIL_DAYS}`, {
    headers: { "X-WELL-API-KEY": process.env.WELL_API_KEY || "" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WP lapsed-members -> ${res.status}`);
  const { members } = (await res.json()) as { members: { email: string; name: string; ended_at: string; paid_months: string }[] };
  return members.map((m) => ({
    email: m.email.toLowerCase(),
    name: m.name,
    source: "website" as const,
    paidMonths: Number(m.paid_months),
    // UMP stores site-local time; treat as UTC, a few hours either way doesn't matter here.
    endedAt: new Date(m.ended_at.replace(" ", "T") + "Z"),
  }));
}

async function appleLapsed(): Promise<Candidate[]> {
  await ensureTables();
  const { rows } = await pool.query<{ email: string; name: string | null; first_seen_at: Date | null; ended_at: Date }>(
    `SELECT a.email, m.name, a.first_seen_at, a.ended_at
       FROM apple_subscriptions a LEFT JOIN members m ON m.email = a.email
      WHERE a.ended_at IS NOT NULL AND a.ended_at > now() - ($1 || ' days')::interval`,
    [String(SEND_UNTIL_DAYS)]
  );
  return rows.map((r) => ({
    email: r.email,
    name: r.name || "",
    source: "apple" as const,
    paidMonths: r.first_seen_at ? Math.max(1, Math.round((r.ended_at.getTime() - r.first_seen_at.getTime()) / (30 * DAY))) : 1,
    endedAt: r.ended_at,
  }));
}

export interface WinbackDecision extends Candidate { send: boolean; reason: string }

/** Who would get the win-back today, and why the rest are skipped. */
export async function planWinbacks(): Promise<WinbackDecision[]> {
  await ensureTables();
  const [website, apple, paid] = await Promise.all([websiteLapsed(), appleLapsed(), getPaidMembers()]);
  const now = Date.now();
  const out: WinbackDecision[] = [];
  const seen = new Set<string>();
  for (const c of [...website, ...apple]) {
    if (seen.has(c.email)) continue;
    seen.add(c.email);
    const age = (now - c.endedAt.getTime()) / DAY;
    const { rows: history } = await pool.query<{ sent_at: Date }>(
      "SELECT sent_at FROM winback_log WHERE email = $1 ORDER BY sent_at DESC", [c.email]
    );
    let reason = "";
    if (isExcludedAccount(c.email, c.name)) reason = "family or test account";
    else if (c.paidMonths < 1) reason = "never paid";
    else if (paid.website.has(c.email) || paid.apple.has(c.email)) reason = "already back";
    else if (age < SEND_AFTER_DAYS) reason = `ended ${Math.floor(age)} days ago, waits until day ${SEND_AFTER_DAYS}`;
    else if (c.paidMonths <= 1 && history.length) reason = "one paid month and already had a win-back";
    else if (history.length && now - history[0].sent_at.getTime() < REPEAT_GAP_DAYS * DAY) reason = "had a win-back recently";
    out.push({ ...c, send: reason === "", reason: reason || "will send" });
  }
  return out;
}

export async function sendWinbacks(): Promise<{ sent: string[] }> {
  const sent: string[] = [];
  for (const d of await planWinbacks()) {
    if (!d.send) continue;
    // Apple-only members may only have their email prefix as a name.
    const first = d.name && d.name !== d.email.split("@")[0] ? firstNameFrom(d.name) : "friend";
    const ok = await sendOutreachEmail(d.email, d.name, renderWinBackEmail({ firstName: first, viaApple: d.source === "apple" }));
    if (!ok) continue;
    await pool.query(
      "INSERT INTO winback_log (email, source, paid_months, ended_at) VALUES ($1, $2, $3, $4)",
      [d.email, d.source, d.paidMonths, d.endedAt]
    );
    sent.push(d.email);
  }
  if (sent.length) console.log(`[WINBACK] sent to ${sent.join(", ")}`);
  return { sent };
}
