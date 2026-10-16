import crypto from "crypto";
import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { sendNotificationToUser } from "../push";
import {
  CARD_DESIGNS, CARD_MESSAGE_MAX, CARD_PHOTO_MAX_CHARS, CARD_PHOTO_RE, CARD_SIGNATURE_MAX,
} from "./tribe";

// Cards a member shares with anyone, members or not (Loretta, 2026-10-16:
// "send cards to people outside of the WELL Collective, with the WELL link and
// logo"). The member gets a private link (lorettabates.com/card/<code>); the
// page there shows the card plus a "Try it free for 30 days" button. We count
// opens and button taps so Loretta can see how many people they bring in.

const router = Router();
const SHARE_PAGE = "https://lorettabates.com/card/";
const DAILY_LIMIT = 20;
const CODE_RE = /^[A-Za-z0-9_-]{16,32}$/;

export async function ensureSharedCardsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_cards (
      code TEXT PRIMARY KEY,
      sender_email TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      to_name TEXT,
      occasion_id TEXT NOT NULL,
      design_id TEXT NOT NULL,
      message TEXT NOT NULL,
      signature TEXT,
      photo TEXT,
      opens INTEGER NOT NULL DEFAULT 0,
      first_opened_at TIMESTAMPTZ,
      last_opened_at TIMESTAMPTZ,
      try_taps INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shared_cards_sender_created ON shared_cards (sender_email, created_at DESC);`);
  // Who started a free trial from a shared card (one row per new member).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_card_signups (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL REFERENCES shared_cards(code) ON DELETE CASCADE,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** Called by /auth/start-trial when someone's first free trial started from a card link. */
export async function recordSharedCardSignup(code: unknown, email: string, name: string): Promise<string | null> {
  if (typeof code !== "string" || !CODE_RE.test(code)) return null;
  const { rows } = await pool.query("SELECT sender_email, sender_name FROM shared_cards WHERE code = $1", [code]);
  if (!rows.length || rows[0].sender_email === email) return null;
  const { rowCount } = await pool.query(
    "INSERT INTO shared_card_signups (email, code, name) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING", [email, code, name]);
  if (!rowCount) return null;
  const friend = firstName(name);
  sendNotificationToUser(rows[0].sender_email, {
    title: "Your card brought a friend!",
    body: `${friend} just started a free trial of the WELL Collective from the card you sent. Thank you for sharing the love!`,
    tag: "shared-card-signup",
    url: "/tribe",
  }).catch((err) => console.error("Shared card signup push (sender) failed:", err));
  return rows[0].sender_name as string;
}

const firstName = (name: string) => (name || "").trim().split(/\s+/)[0] || "A friend";

// Make a shareable card. Only WELL Collective members can make one.
router.post("/cards/share", async (req, res) => {
  const { email, occasionId, designId, message, signature, photo, toName } = req.body as {
    email?: string; occasionId?: string; designId?: string; message?: string; signature?: string; photo?: string; toName?: string;
  };
  if (!email || !occasionId || !designId) return res.status(400).json({ error: "email, occasionId and designId required" });
  const allowed = CARD_DESIGNS[occasionId];
  if (!allowed) return res.status(400).json({ error: "Unknown occasion" });
  if (designId === "photo") {
    if (!photo || !CARD_PHOTO_RE.test(photo) || photo.length > CARD_PHOTO_MAX_CHARS) {
      return res.status(400).json({ error: "That photo could not be used. Try a smaller one." });
    }
  } else if (!allowed.includes(designId)) {
    return res.status(400).json({ error: "Unknown design" });
  }
  if (photo && (!CARD_PHOTO_RE.test(photo) || photo.length > CARD_PHOTO_MAX_CHARS)) {
    return res.status(400).json({ error: "That photo could not be used. Try a smaller one." });
  }
  const sender = email.toLowerCase().trim();
  try {
    const { rows } = await pool.query("SELECT name FROM members WHERE email = $1", [sender]);
    if (!rows.length) return res.status(403).json({ error: "Only WELL Collective members can share cards." });
    const { rows: today } = await pool.query(
      "SELECT count(*)::int AS n FROM shared_cards WHERE sender_email = $1 AND created_at > now() - interval '1 day'", [sender]);
    if (today[0].n >= DAILY_LIMIT) return res.status(429).json({ error: "That's a lot of love for one day! You can share more cards tomorrow." });

    const code = crypto.randomBytes(12).toString("base64url");
    await pool.query(
      `INSERT INTO shared_cards (code, sender_email, sender_name, to_name, occasion_id, design_id, message, signature, photo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [code, sender, firstName(rows[0].name), (toName || "").trim().slice(0, 40) || null, occasionId, designId,
        (message || "").slice(0, CARD_MESSAGE_MAX), signature ? signature.trim().slice(0, CARD_SIGNATURE_MAX) : null,
        photo || null]
    );
    res.status(201).json({ code, url: SHARE_PAGE + code });
  } catch (err) {
    console.error("Share card error:", err);
    res.status(500).json({ error: "Could not make the card link" });
  }
});

// Open a shared card (public: the link is the key). ?count=0 reads without
// counting an open (used for the link preview text).
router.get("/cards/shared/:code", async (req, res) => {
  const code = req.params.code;
  if (!CODE_RE.test(code)) return res.status(404).json({ error: "Card not found" });
  try {
    const count = req.query.count !== "0";
    const { rows } = count
      ? await pool.query(
        `UPDATE shared_cards SET opens = opens + 1, first_opened_at = COALESCE(first_opened_at, now()), last_opened_at = now()
         WHERE code = $1 RETURNING *`, [code])
      : await pool.query("SELECT * FROM shared_cards WHERE code = $1", [code]);
    if (!rows.length) return res.status(404).json({ error: "Card not found" });
    const r = rows[0];
    res.set("Cache-Control", "no-store");
    res.json({
      card: {
        occasionId: r.occasion_id, designId: r.design_id, message: r.message, signature: r.signature,
        photo: count ? r.photo : null, senderName: r.sender_name, toName: r.to_name,
        // Cards from Loretta herself say she is the founder of the WELL Collective, instead of "dances with".
        fromLoretta: r.sender_email === "loretta@lorettabates.com",
      },
    });
  } catch (err) {
    console.error("Open shared card error:", err);
    res.status(500).json({ error: "Could not open the card" });
  }
});

// Someone tapped "Try it free for 30 days" under a shared card.
router.post("/cards/shared/:code/try", async (req, res) => {
  const code = req.params.code;
  if (!CODE_RE.test(code)) return res.status(404).end();
  try {
    await pool.query("UPDATE shared_cards SET try_taps = try_taps + 1 WHERE code = $1", [code]);
    res.status(204).end();
  } catch (err) {
    console.error("Shared card try tap error:", err);
    res.status(500).end();
  }
});

// Loretta's count: cards shared outside the WELL Collective, opened, and taps on the free trial button.
router.get("/admin/cards/shared-stats", requireAdmin, async (_req, res) => {
  // Loretta's own cards (like the one in the members email) are left out, so the count shows
  // how much members really use sharing (she asked 2026-10-16).
  const L = "'loretta@lorettabates.com'";
  try {
    const { rows: [t] } = await pool.query(`
      SELECT count(*)::int AS shared,
             count(*) FILTER (WHERE opens > 0)::int AS opened,
             COALESCE(sum(try_taps), 0)::int AS try_taps,
             count(*) FILTER (WHERE try_taps > 0)::int AS cards_with_try,
             count(DISTINCT sender_email)::int AS senders,
             count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS shared_30d,
             (SELECT count(*)::int FROM shared_card_signups s JOIN shared_cards c1 ON c1.code = s.code WHERE c1.sender_email <> ${L}) AS signups,
             (SELECT count(*)::int FROM shared_card_signups s JOIN members m ON m.email = s.email
               JOIN shared_cards c2 ON c2.code = s.code
               WHERE m.membership_status = 'active' AND c2.sender_email <> ${L}) AS paying
      FROM shared_cards WHERE sender_email <> ${L}`);
    const { rows: joined } = await pool.query(`
      SELECT s.name, s.created_at, c.sender_name, (m.membership_status = 'active') AS paying
      FROM shared_card_signups s JOIN shared_cards c ON c.code = s.code
      LEFT JOIN members m ON m.email = s.email
      WHERE c.sender_email <> ${L}
      ORDER BY s.created_at DESC LIMIT 15`);
    const { rows: recent } = await pool.query(`
      SELECT c.sender_name, c.to_name, c.occasion_id, c.opens, c.try_taps, c.created_at,
             (SELECT count(*)::int FROM shared_card_signups s WHERE s.code = c.code) AS signups
      FROM shared_cards c WHERE c.sender_email <> ${L} ORDER BY c.created_at DESC LIMIT 15`);
    const { rows: top } = await pool.query(`
      SELECT c.sender_name, c.sender_email, count(*)::int AS shared, COALESCE(sum(c.try_taps), 0)::int AS try_taps,
             (SELECT count(*)::int FROM shared_card_signups s JOIN shared_cards c2 ON c2.code = s.code WHERE c2.sender_email = c.sender_email) AS signups
      FROM shared_cards c WHERE c.sender_email <> ${L} GROUP BY c.sender_name, c.sender_email ORDER BY signups DESC, shared DESC LIMIT 5`);
    res.json({
      totals: t,
      recent: recent.map((r) => ({ senderName: r.sender_name, toName: r.to_name, occasionId: r.occasion_id, opens: r.opens, tryTaps: r.try_taps, signups: r.signups, createdAt: new Date(r.created_at).toISOString() })),
      joined: joined.map((r) => ({ name: r.name, senderName: r.sender_name, paying: !!r.paying, createdAt: new Date(r.created_at).toISOString() })),
      topSharers: top.map((r) => ({ name: r.sender_name, shared: r.shared, tryTaps: r.try_taps, signups: r.signups })),
    });
  } catch (err) {
    console.error("Shared card stats error:", err);
    res.status(500).json({ error: "Could not load card counts" });
  }
});

export default router;
