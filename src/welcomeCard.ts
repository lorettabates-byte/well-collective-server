// Loretta's welcome card (approved design 2026-10-16).
//
// 1. New members: sent once when a membership or trial starts. Off until
//    WELCOME_CARD_ENABLED=true is set on the server (Loretta says go).
// 2. Current members: a one-time broadcast an admin starts by hand
//    (POST /api/admin/cards/welcome-broadcast). Never runs on its own.
//
// Never twice: a unique index allows one welcome card per recipient
// (idx_tribe_cards_one_welcome in db.ts), and every insert is ON CONFLICT DO NOTHING.
import { pool } from "./db";
import { ADMIN_NOTIFY_EMAILS, sendNotificationToUser } from "./push";
import { createMemberNotification } from "./memberNotifications";
import { isExcludedAccount } from "./paidMembers";
import { getFlag, setFlag } from "./membershipEvents";

export const WELCOME_OCCASION = "welcome";
export const WELCOME_SENDER_NAME = "Loretta";
export const WELCOME_SIGNATURE = "With love, Loretta";

// Mirrors NOTES.welcome in the approved cards-art.js.
export const NEW_MEMBER_NOTE =
  "I am SO happy you are here! Come dance with me, say hi in the community, and remember: wellness is a journey, not a destination. Let's live life lifted...together!";

// For members who were already here when the new cards launched.
export const ANNOUNCE_NOTE =
  "Surprise! We have brand-new cards in the app, and this one is just for you. Send one to someone you love, add your own photo, and make their day! Let's live life lifted...together!";

export function welcomeCardEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.WELCOME_CARD_ENABLED || "").trim());
}

function skipAccount(email: string, name?: string | null): boolean {
  const e = email.trim().toLowerCase();
  return !e.includes("@") || isExcludedAccount(e, name) || ADMIN_NOTIFY_EMAILS.includes(e);
}

const pendingKey = (email: string) => `welcome-card-pending:${email}`;

/**
 * Inserts Loretta's welcome card for one member and sends the usual card push.
 * Returns the new card id, or null when they already had one.
 */
export async function deliverWelcomeCard(email: string, note: string): Promise<number | null> {
  const e = email.trim().toLowerCase();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO tribe_cards (sender_email, sender_name, recipient_email, occasion_id, style_id, design_id, message, signature)
     VALUES (NULL, $1, $2, $3, $3, $3, $4, $5)
     ON CONFLICT (recipient_email) WHERE occasion_id = 'welcome' DO NOTHING
     RETURNING id`,
    [WELCOME_SENDER_NAME, e, WELCOME_OCCASION, note, WELCOME_SIGNATURE]
  );
  if (!rows.length) return null;
  const cardId = Number(rows[0].id);
  const link = `/tribe?card=${cardId}`;
  const title = `You received a card from ${WELCOME_SENDER_NAME}`;
  await createMemberNotification({
    memberEmail: e,
    type: "tribe",
    title,
    body: "Tap to open your card.",
    link,
    metadata: { cardId },
  }).catch((err) => console.error("[WELCOME CARD] inbox note failed:", err));
  await sendNotificationToUser(e, {
    title,
    body: "Open your card in WELL Collective.",
    tag: "tribe-card",
    url: link,
  }).catch((err) => console.error("[WELCOME CARD] push failed:", err));
  return cardId;
}

/**
 * New member hook: call when a trial or paid membership has just started.
 * Safe to call more than once. Does nothing unless WELCOME_CARD_ENABLED is on.
 * If they have no app account yet (joined on the website first), the card waits
 * and goes out the first time the app saves their profile.
 */
export async function maybeSendWelcomeCard(email: string, why: string, name?: string | null): Promise<void> {
  if (!welcomeCardEnabled()) return;
  const e = email.trim().toLowerCase();
  if (skipAccount(e, name)) return;
  try {
    const { rows } = await pool.query("SELECT name FROM members WHERE email = $1", [e]);
    if (!rows.length) {
      await setFlag(pendingKey(e), why);
      console.log(`[WELCOME CARD] waiting for app account: ${e} (${why})`);
      return;
    }
    if (skipAccount(e, rows[0].name)) return;
    const id = await deliverWelcomeCard(e, NEW_MEMBER_NOTE);
    if (id) console.log(`[WELCOME CARD] sent #${id} to ${e} (${why})`);
  } catch (err) {
    console.error("[WELCOME CARD] failed:", err);
  }
}

/** Profile sync hook: send a welcome card that was waiting for this member's first app login. */
export async function sendPendingWelcomeCard(email: string): Promise<void> {
  if (!welcomeCardEnabled()) return;
  const e = email.trim().toLowerCase();
  try {
    const why = await getFlag(pendingKey(e));
    if (!why) return;
    await pool.query("DELETE FROM membership_tracking WHERE key = $1", [pendingKey(e)]);
    await maybeSendWelcomeCard(e, `${why}, first app login`);
  } catch (err) {
    console.error("[WELCOME CARD] pending send failed:", err);
  }
}

// ---------------------------------------------------------------------------
// One-time broadcast to current members
// ---------------------------------------------------------------------------

export interface BroadcastPlan {
  recipients: { email: string; name: string }[];
  alreadyHaveOne: number;
  skipped: number;
}

/** Everyone with an app account who is a current member (paying or in an active trial). */
export async function planWelcomeBroadcast(onlyEmail?: string): Promise<BroadcastPlan> {
  const only = onlyEmail?.trim().toLowerCase() || null;
  const { rows } = await pool.query<{ email: string; name: string; has_card: boolean }>(
    `SELECT m.email, m.name,
            EXISTS (SELECT 1 FROM tribe_cards c WHERE c.recipient_email = m.email AND c.occasion_id = 'welcome') AS has_card
       FROM members m
      WHERE ($1::text IS NULL AND (m.membership_status = 'active' OR (m.trial_ends_at IS NOT NULL AND m.trial_ends_at >= CURRENT_DATE)))
         OR m.email = $1
      ORDER BY m.email`,
    [only]
  );
  const plan: BroadcastPlan = { recipients: [], alreadyHaveOne: 0, skipped: 0 };
  for (const r of rows) {
    if (r.has_card) { plan.alreadyHaveOne++; continue; }
    // A single test send (onlyEmail) may go to an admin account so Loretta can see it.
    if (!only && skipAccount(r.email, r.name)) { plan.skipped++; continue; }
    if (only && isExcludedAccount(r.email, r.name)) { plan.skipped++; continue; }
    plan.recipients.push({ email: r.email, name: r.name });
  }
  return plan;
}

let broadcastRunning = false;
export function welcomeBroadcastRunning(): boolean {
  return broadcastRunning;
}

/** Sends one at a time with a pause between pushes. Logs and saves a summary when done. */
export async function runWelcomeBroadcast(recipients: { email: string }[], pauseMs = 250): Promise<void> {
  if (broadcastRunning) return;
  broadcastRunning = true;
  const started = new Date();
  let sent = 0, already = 0, failed = 0;
  try {
    for (const r of recipients) {
      try {
        const id = await deliverWelcomeCard(r.email, ANNOUNCE_NOTE);
        if (id) sent++; else already++;
      } catch (err) {
        failed++;
        console.error(`[WELCOME BROADCAST] ${r.email} failed:`, err);
      }
      await new Promise((ok) => setTimeout(ok, pauseMs));
    }
  } finally {
    broadcastRunning = false;
    const summary = { startedAt: started.toISOString(), finishedAt: new Date().toISOString(), planned: recipients.length, sent, alreadyHadOne: already, failed };
    console.log("[WELCOME BROADCAST] done", JSON.stringify(summary));
    await setFlag("welcome-broadcast-last", JSON.stringify(summary)).catch(() => {});
  }
}

export async function lastWelcomeBroadcast(): Promise<unknown> {
  const raw = await getFlag("welcome-broadcast-last").catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}
