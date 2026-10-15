import crypto from "crypto";
import { pool } from "./db";
import { ADMIN_NOTIFY_EMAILS, sendNotificationToUser } from "./push";
import { isExcludedAccount } from "./paidMembers";
import { sendCancelReasonEmail } from "./brevo";

export type Source = "website" | "app_store" | "google_play";
export type Kind = "joined" | "cancelled" | "resumed" | "ended";

export const REASONS: Record<string, string> = {
  too_expensive: "Too expensive",
  not_using: "Not using it enough",
  missing_something: "Missing something I want",
  technical: "Technical problems",
  taking_a_break: "Just taking a break",
  other: "Other",
};

export const SOURCE_LABEL: Record<Source, string> = {
  website: "lorettabates.com",
  app_store: "App Store",
  google_play: "Google Play",
};

// Store-side cancel reasons (RevenueCat cancel_reason), in plain words.
export const STORE_REASON_LABEL: Record<string, string> = {
  UNSUBSCRIBE: "Turned off renewal",
  BILLING_ERROR: "Card failed",
  PRICE_INCREASE: "Price increase",
  CUSTOMER_SUPPORT: "Refunded by the store",
  DEVELOPER_INITIATED: "Cancelled by us",
  UNKNOWN: "Not given",
};

let ready: Promise<void> | null = null;
export function ensureMembershipTables(): Promise<void> {
  ready ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS membership_events (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        gateway TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        date_known BOOLEAN NOT NULL DEFAULT TRUE,
        member_since TIMESTAMPTZ,
        access_until TIMESTAMPTZ,
        store_reason TEXT,
        via TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS membership_events_email_idx ON membership_events (email, source, occurred_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS membership_events_month_idx ON membership_events (occurred_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cancel_reasons (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        reason TEXT NOT NULL,
        note TEXT,
        asked_via TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS cancel_reasons_email_idx ON cancel_reasons (email, created_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS membership_tracking (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  })();
  return ready;
}

export async function getFlag(key: string): Promise<string | null> {
  await ensureMembershipTables();
  const { rows } = await pool.query<{ value: string }>("SELECT value FROM membership_tracking WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setFlag(key: string, value: string): Promise<void> {
  await ensureMembershipTables();
  await pool.query(
    `INSERT INTO membership_tracking (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, value]
  );
}

async function lastEvent(email: string, source: Source): Promise<{ kind: Kind; occurred_at: Date } | null> {
  const { rows } = await pool.query<{ kind: Kind; occurred_at: Date }>(
    `SELECT kind, occurred_at FROM membership_events WHERE email = $1 AND source = $2
     ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [email, source]
  );
  return rows[0] ?? null;
}

// When this person's current membership started: the joined event that opened it.
export async function memberSince(email: string, source: Source): Promise<Date | null> {
  const { rows } = await pool.query<{ occurred_at: Date; date_known: boolean }>(
    `SELECT occurred_at, date_known FROM membership_events
     WHERE email = $1 AND source = $2 AND kind = 'joined'
     ORDER BY occurred_at DESC LIMIT 1`,
    [email, source]
  );
  return rows[0] && rows[0].date_known ? rows[0].occurred_at : null;
}

async function memberName(email: string, fallback?: string | null): Promise<string> {
  if (fallback && fallback.trim() && !fallback.includes("@")) return fallback.trim();
  const { rows } = await pool.query<{ name: string | null }>("SELECT name FROM members WHERE email = $1", [email]);
  const n = rows[0]?.name?.trim();
  return n && !n.includes("@") ? n : email.split("@")[0];
}

export function tenureText(since: Date | null, until: Date): string {
  if (!since) return "length unknown";
  const days = Math.max(0, Math.round((until.getTime() - since.getTime()) / 86_400_000));
  if (days < 45) return days <= 1 ? "1 day" : `${days} days`;
  const months = Math.round(days / 30.4);
  return months === 1 ? "1 month" : `${months} months`;
}

export interface EventInput {
  email: string;
  name?: string | null;
  kind: Kind;
  source: Source;
  gateway?: string | null;
  occurredAt?: Date;
  dateKnown?: boolean;
  memberSince?: Date | null;
  accessUntil?: Date | null;
  storeReason?: string | null;
  via: "revenuecat_webhook" | "revenuecat_poll" | "website_hook" | "website_poll" | "backfill";
  notify?: boolean;
}

// Allowed next steps, so the webhook, the website hook and the polling backstop never double count.
const ALLOWED: Record<Kind, (Kind | null)[]> = {
  joined: [null, "ended"],
  cancelled: [null, "joined", "resumed"],
  resumed: ["cancelled"],
  ended: ["joined", "cancelled", "resumed"],
};

export async function recordMembershipEvent(input: EventInput): Promise<boolean> {
  await ensureMembershipTables();
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@") || isExcludedAccount(email, input.name)) return false;

  const prev = await lastEvent(email, input.source);
  if (!ALLOWED[input.kind].includes(prev?.kind ?? null)) return false;

  const occurredAt = input.occurredAt ?? new Date();
  const name = await memberName(email, input.name);
  const since =
    input.kind === "joined" ? (input.dateKnown === false ? null : occurredAt) : input.memberSince ?? (await memberSince(email, input.source));

  await pool.query(
    `INSERT INTO membership_events
       (email, name, kind, source, gateway, occurred_at, date_known, member_since, access_until, store_reason, via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [email, name, input.kind, input.source, input.gateway ?? null, occurredAt, input.dateKnown !== false,
     since, input.accessUntil ?? null, input.storeReason ?? null, input.via]
  );

  if (input.notify !== false) {
    notifyOwner({ ...input, email, name, since, occurredAt }).catch((err) =>
      console.error("[MEMBERSHIP] owner push failed:", err)
    );
    if (input.kind === "cancelled" && input.storeReason !== "BILLING_ERROR") {
      maybeAskWhy(email, name).catch((err) => console.error("[MEMBERSHIP] why email failed:", err));
    }
  }
  console.log(`[MEMBERSHIP] ${input.kind} ${input.source} ${email} via ${input.via}`);
  return true;
}

async function latestReason(email: string, withinDays: number): Promise<{ reason: string; note: string | null } | null> {
  const { rows } = await pool.query<{ reason: string; note: string | null }>(
    `SELECT reason, note FROM cancel_reasons
     WHERE email = $1 AND created_at > now() - ($2 || ' days')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [email, String(withinDays)]
  );
  return rows[0] ?? null;
}

async function notifyOwner(e: EventInput & { email: string; name: string; since: Date | null; occurredAt: Date }): Promise<void> {
  const where = SOURCE_LABEL[e.source] + (e.gateway ? ` (${e.gateway})` : "");
  let title = "";
  let body = "";
  if (e.kind === "joined") {
    title = "New paying member";
    body = `${e.name} just joined the WELL Collective from ${where}.`;
  } else if (e.kind === "cancelled") {
    const r = await latestReason(e.email, 3);
    const why = r ? REASONS[r.reason] ?? r.reason : e.storeReason ? STORE_REASON_LABEL[e.storeReason] ?? e.storeReason : "no reason yet";
    title = "Membership cancelled";
    body = `${e.name} cancelled on ${where} after ${tenureText(e.since, e.occurredAt)}. Reason: ${why}.`;
  } else if (e.kind === "resumed") {
    title = "Membership back on";
    body = `${e.name} turned their ${where} membership back on.`;
  } else {
    return; // "ended" is the quiet follow-up to a cancellation; it shows in the report only.
  }
  for (const admin of ADMIN_NOTIFY_EMAILS) {
    await sendNotificationToUser(admin, { title, body, tag: `membership-${e.kind}`, url: "/admin/analytics?tab=movement" });
  }
}

// The "why" email goes to people who cancelled outside the app's own question (store settings, website).
async function maybeAskWhy(email: string, name: string): Promise<void> {
  if (await latestReason(email, 3)) return;
  const { rows } = await pool.query(
    `SELECT 1 FROM membership_tracking WHERE key = $1`,
    [`why-asked:${email}:${new Date().toISOString().slice(0, 7)}`]
  );
  if (rows.length) return;
  const sent = await sendCancelReasonEmail(email, name, reasonToken(email));
  if (sent) await setFlag(`why-asked:${email}:${new Date().toISOString().slice(0, 7)}`, "1");
}

export async function saveCancelReason(email: string, reason: string, note: string | null, askedVia: "app" | "website" | "email"): Promise<boolean> {
  await ensureMembershipTables();
  const e = email.trim().toLowerCase();
  if (!e.includes("@") || !(reason in REASONS)) return false;
  const cleanNote = note ? note.toString().trim().slice(0, 1000) || null : null;
  const recent = await pool.query<{ id: number }>(
    `SELECT id FROM cancel_reasons WHERE email = $1 AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 1`,
    [e]
  );
  if (recent.rows[0]) {
    await pool.query(
      `UPDATE cancel_reasons SET reason = $2, note = COALESCE($3, note), asked_via = $4, created_at = now() WHERE id = $1`,
      [recent.rows[0].id, reason, cleanNote, askedVia]
    );
  } else {
    await pool.query(`INSERT INTO cancel_reasons (email, reason, note, asked_via) VALUES ($1,$2,$3,$4)`, [e, reason, cleanNote, askedVia]);
  }
  return true;
}

// Signed so the links in the "why" email can't be used to file answers for someone else.
export function reasonToken(email: string): string {
  const e = email.trim().toLowerCase();
  const sig = crypto.createHmac("sha256", process.env.JWT_SECRET || "well").update(`why:${e}`).digest("base64url").slice(0, 22);
  return `${Buffer.from(e).toString("base64url")}.${sig}`;
}

export function emailFromReasonToken(token: string): string | null {
  const [b64, sig] = (token || "").split(".");
  if (!b64 || !sig) return null;
  let email: string;
  try { email = Buffer.from(b64, "base64url").toString("utf8"); } catch { return null; }
  const expected = reasonToken(email).split(".")[1];
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return email;
}

/**
 * Backstop for anything the webhooks missed: compares who is paying now with what the log says.
 * The first run records the starting point from known start dates, without pushes, and fills in
 * members who already left, so the report has history instead of 39 "joined today" rows.
 */
export async function reconcileFromSnapshot(snapshot: {
  website: Map<string, { name?: string | null; gateway?: string | null; startedAt?: string | null }>;
  store: Map<string, { store: "app_store" | "google_play"; willRenew: boolean | null; endsAt: number | null; startedAt: number | null }>;
  lapsed?: { email: string; name?: string | null; source: Source; startedAt?: string | number | null; endedAt: string | number }[];
}): Promise<void> {
  await ensureMembershipTables();
  const seeded = (await getFlag("seeded")) === "1";
  const when = (v: string | number | null | undefined): Date | null => {
    if (v === null || v === undefined || v === "") return null;
    const d = typeof v === "number" ? new Date(v) : new Date(String(v).replace(" ", "T") + (String(v).includes("Z") || String(v).includes("+") ? "" : "Z"));
    return isNaN(d.getTime()) ? null : d;
  };
  const joinedAt = (v: string | number | null | undefined) => {
    if (seeded) return { occurredAt: new Date(), dateKnown: true };
    const d = when(v);
    return d ? { occurredAt: d, dateKnown: true } : { occurredAt: new Date("2026-01-01T12:00:00Z"), dateKnown: false };
  };

  if (!seeded && snapshot.lapsed) {
    for (const l of snapshot.lapsed) {
      const ended = when(l.endedAt);
      if (!ended) continue;
      await recordMembershipEvent({ email: l.email, name: l.name, kind: "joined", source: l.source, via: "backfill", notify: false, ...joinedAt(l.startedAt) });
      await recordMembershipEvent({ email: l.email, name: l.name, kind: "ended", source: l.source, via: "backfill", notify: false, occurredAt: ended });
    }
  }

  for (const [email, m] of snapshot.website) {
    await recordMembershipEvent({
      email, name: m.name, kind: "joined", source: "website", gateway: m.gateway ?? null,
      via: seeded ? "website_poll" : "backfill", notify: seeded, ...joinedAt(m.startedAt),
    });
  }
  for (const [email, s] of snapshot.store) {
    const via = seeded ? "revenuecat_poll" : "backfill";
    await recordMembershipEvent({ email, kind: "joined", source: s.store, via, notify: seeded, ...joinedAt(s.startedAt) });
    if (s.willRenew === false) {
      await recordMembershipEvent({ email, kind: "cancelled", source: s.store, via, notify: seeded, accessUntil: s.endsAt ? new Date(s.endsAt) : null });
    } else if (s.willRenew === true) {
      await recordMembershipEvent({ email, kind: "resumed", source: s.store, via, notify: seeded });
    }
  }

  // Anyone the log still counts as a member who is no longer paying has ended.
  const { rows } = await pool.query<{ email: string; source: Source; kind: Kind; access_until: Date | null }>(
    `SELECT DISTINCT ON (email, source) email, source, kind, access_until
       FROM membership_events ORDER BY email, source, occurred_at DESC, id DESC`
  );
  const now = Date.now();
  for (const r of rows) {
    if (r.kind === "ended") continue;
    const stillPaying = r.source === "website" ? snapshot.website.has(r.email) : snapshot.store.has(r.email);
    if (stillPaying) continue;
    // A cancelled member keeps access to the end of what they paid for.
    if (r.access_until && r.access_until.getTime() > now) continue;
    await recordMembershipEvent({
      email: r.email, kind: "ended", source: r.source, via: r.source === "website" ? "website_poll" : "revenuecat_poll",
      occurredAt: r.access_until ?? new Date(), notify: false,
    });
  }
  if (!seeded) await setFlag("seeded", "1");
}
