import { Router } from "express";
import { verifyMembership } from "../membership";
import { checkReferralConversion } from "./referrals";
import { pool } from "../db";

const router = Router();

const WORDPRESS_URL = process.env.WORDPRESS_URL || "https://lorettabates.com";
const WELL_API_KEY = process.env.WELL_API_KEY || "";

// Called by the app after a new IAP subscription is purchased by a first-time
// user. Creates the member record if needed, activates UMP, and returns an
// auth token so the app can log them in immediately.
router.post("/iap/register", async (req, res) => {
  const email = (req.body.email as string | undefined)?.trim().toLowerCase();
  const name = ((req.body.name as string | undefined) || "").trim();
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO members (email, name, membership_status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (email) DO UPDATE SET membership_status = 'active'`,
      [email, name]
    );

    if (WELL_API_KEY) {
      await fetch(`${WORDPRESS_URL}/videolibrary.lorettabates.com/wp-json/well/v1/assign-level`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WELL-API-KEY": WELL_API_KEY },
        body: JSON.stringify({ email, level_id: 4, days: 32 }),
        signal: AbortSignal.timeout(8000),
      }).catch((err) => console.error("IAP register UMP error:", err));
    }

    checkReferralConversion(email).catch((err) =>
      console.error("Referral conversion check error:", err)
    );

    const token = Buffer.from(`${email}:${Date.now()}`).toString("base64");
    res.json({ token, user: { email, name } });
  } catch (err) {
    console.error("IAP register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Called by the app after a successful IAP purchase to sync the membership
// into UMP (so web login also works) and mark them active in our DB.
router.post("/iap/activate", async (req, res) => {
  const email = (req.body.email as string | undefined)?.trim().toLowerCase();
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  try {
    // Activate UMP level 4 (WELL COLLECTIVE MEMBER) on WordPress
    if (WELL_API_KEY) {
      await fetch(`${WORDPRESS_URL}/videolibrary.lorettabates.com/wp-json/well/v1/assign-level`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WELL-API-KEY": WELL_API_KEY },
        body: JSON.stringify({ email, level_id: 4, days: 32 }),
        signal: AbortSignal.timeout(8000),
      }).catch((err) => console.error("IAP UMP activation error:", err));
    }

    // Mark active in our database
    await pool.query(
      "UPDATE members SET membership_status = 'active' WHERE email = $1",
      [email]
    );

    checkReferralConversion(email).catch((err) =>
      console.error("Referral conversion check error:", err)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("IAP activate error:", err);
    res.status(500).json({ error: "Activation failed" });
  }
});

router.get("/membership/status", async (req, res) => {
  const email = (req.query.email as string | undefined)?.trim();
  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  let active = await verifyMembership(email);

  const { rows } = await pool.query(
    "SELECT membership_status FROM members WHERE email = $1",
    [email.toLowerCase()]
  );
  const dbStatus = rows[0]?.membership_status;

  // IAP subscribers (App Store / Play Store) have membership_status='active' in
  // the DB but no UMP record. Accept either source as authoritative.
  if (!active && dbStatus === "active") {
    active = true;
  }

  // When newly active via UMP, sync to DB and check referral conversion.
  if (active && dbStatus !== "active") {
    await pool.query(
      "UPDATE members SET membership_status = 'active' WHERE email = $1",
      [email.toLowerCase()]
    ).catch(() => {});
    checkReferralConversion(email).catch((err) =>
      console.error("Referral conversion check error:", err)
    );
  }

  res.json({ active });
});

// One-time restoration endpoint — restores all active trial members back into UMP
// after the trial level was accidentally deleted. Safe to call multiple times (UMP upserts).
router.post("/admin/restore-ump-trials", async (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.WELL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const levelId = parseInt((req.query.level_id as string) || "7", 10);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    const { rows } = await pool.query(`
      SELECT name, email, trial_ends_at
      FROM members
      WHERE trial_ends_at >= CURRENT_DATE
        AND membership_status != 'active'
        AND email NOT IN ('rettabates@yahoo.com', 'demo@wellcollective.app')
      ORDER BY trial_ends_at
    `);

    const results: { email: string; name: string; days: number; ok: boolean; error?: string }[] = [];

    for (const member of rows) {
      const endsAt = new Date(member.trial_ends_at);
      endsAt.setHours(0, 0, 0, 0);
      const daysRemaining = Math.max(1, Math.round((endsAt.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));

      try {
        const wpRes = await fetch(`${WORDPRESS_URL}/wp-json/well/v1/create-trial`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-WELL-API-KEY": WELL_API_KEY },
          body: JSON.stringify({ email: member.email, name: member.name, trial_days: daysRemaining, level_id: levelId }),
          signal: AbortSignal.timeout(10000),
        });
        const text = await wpRes.text();
        results.push({ email: member.email, name: member.name, days: daysRemaining, ok: wpRes.ok, error: wpRes.ok ? undefined : text });
      } catch (err) {
        results.push({ email: member.email, name: member.name, days: daysRemaining, ok: false, error: String(err) });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    const succeeded = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    res.json({ total: results.length, succeeded, failed });
  } catch (err) {
    console.error("Restore UMP trials error:", err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;
