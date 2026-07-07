import { Router } from "express";
import { pool } from "../db";
import { awardPoints, POINT_VALUES } from "./points";
import { sendNotificationToUser } from "../push";
import { requireAdmin } from "../middleware/adminAuth";
import crypto from "crypto";

const router = Router();

const REFERRAL_BONUS_POINTS = 25;
const CONVERSION_BONUS_POINTS = 50;
const REFERRAL_TRIAL_DAYS = 30;

function generateCode(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 6);
  const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `WELL-${slug || "FRIEND"}-${suffix}`;
}

// GET /api/referrals/my-code — returns the member's referral code (creates one if needed)
router.get("/my-code", async (req, res) => {
  const email = (req.query.email as string)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const { rows } = await pool.query(
      "SELECT referral_code, name FROM members WHERE email = $1",
      [email]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Member not found" });

    let code = rows[0].referral_code;
    if (!code) {
      code = generateCode(rows[0].name || "FRIEND");
      await pool.query("UPDATE members SET referral_code = $1 WHERE email = $2", [code, email]);
    }

    const { rows: stats } = await pool.query(
      `SELECT
         COUNT(*) AS total_referrals,
         COUNT(converted_at) AS conversions
       FROM referrals WHERE referrer_email = $1`,
      [email]
    );

    res.json({
      code,
      totalReferrals: Number(stats[0]?.total_referrals || 0),
      conversions: Number(stats[0]?.conversions || 0),
    });
  } catch (err) {
    console.error("[REFERRALS] Error getting code:", err);
    res.status(500).json({ error: "Failed to get referral code" });
  }
});

// GET /api/referrals/validate?code=X — checks if a referral code is valid
router.get("/validate", async (req, res) => {
  const code = (req.query.code as string)?.toUpperCase().trim();
  if (!code) return res.status(400).json({ error: "Code required" });

  try {
    const { rows } = await pool.query(
      "SELECT email, name FROM members WHERE referral_code = $1",
      [code]
    );

    if (rows.length === 0) {
      return res.json({ valid: false });
    }

    res.json({
      valid: true,
      referrerName: rows[0].name,
      trialDays: REFERRAL_TRIAL_DAYS,
    });
  } catch (err) {
    console.error("[REFERRALS] Validate error:", err);
    res.status(500).json({ error: "Failed to validate code" });
  }
});

// POST /api/referrals/apply — called after a friend signs up with a referral code
// Body: { referralCode, friendEmail }
router.post("/apply", async (req, res) => {
  const { referralCode, friendEmail } = req.body as {
    referralCode?: string;
    friendEmail?: string;
  };

  if (!referralCode || !friendEmail) {
    return res.status(400).json({ error: "referralCode and friendEmail required" });
  }

  const code = referralCode.toUpperCase().trim();
  const email = friendEmail.toLowerCase().trim();

  try {
    const { rows: referrerRows } = await pool.query(
      "SELECT email, name FROM members WHERE referral_code = $1",
      [code]
    );
    if (referrerRows.length === 0) {
      return res.status(404).json({ error: "Invalid referral code" });
    }

    const referrerEmail = referrerRows[0].email;
    if (referrerEmail === email) {
      return res.status(400).json({ error: "Cannot use your own referral code" });
    }

    // Record the referral
    await pool.query(
      `INSERT INTO referrals (referrer_email, referred_email)
       VALUES ($1, $2) ON CONFLICT (referrer_email, referred_email) DO NOTHING`,
      [referrerEmail, email]
    );

    // Mark the friend as referred
    await pool.query(
      "UPDATE members SET referred_by = $1 WHERE email = $2 AND referred_by IS NULL",
      [referrerEmail, email]
    );

    // Award signup bonus to referrer (25 pts)
    const { rows: bonusCheck } = await pool.query(
      `SELECT referrer_signup_bonus_awarded FROM referrals
       WHERE referrer_email = $1 AND referred_email = $2`,
      [referrerEmail, email]
    );

    if (bonusCheck.length > 0 && !bonusCheck[0].referrer_signup_bonus_awarded) {
      // 25 pts to the referrer
      await pool.query(
        `INSERT INTO activity_logs (member_email, activity_type, points, metadata)
         VALUES ($1, 'referral_signup', $2, $3)`,
        [referrerEmail, REFERRAL_BONUS_POINTS, JSON.stringify({ friendEmail: email })]
      );
      // 25 pts to the referred member
      await pool.query(
        `INSERT INTO activity_logs (member_email, activity_type, points, metadata)
         VALUES ($1, 'referral_signup', $2, $3)`,
        [email, REFERRAL_BONUS_POINTS, JSON.stringify({ referredBy: referrerEmail })]
      );
      await pool.query(
        `UPDATE referrals SET referrer_signup_bonus_awarded = TRUE
         WHERE referrer_email = $1 AND referred_email = $2`,
        [referrerEmail, email]
      );

      sendNotificationToUser(referrerEmail, {
        title: "Your friend joined! 🎉",
        body: `Someone used your referral code and you earned ${REFERRAL_BONUS_POINTS} points!`,
        tag: "referral",
        url: "/profile",
      }).catch(() => {});

      sendNotificationToUser(email, {
        title: "Referral bonus applied! 🎉",
        body: `You earned ${REFERRAL_BONUS_POINTS} bonus points for joining with a referral code. Welcome!`,
        tag: "referral",
        url: "/well-cup",
      }).catch(() => {});
    }

    res.json({ ok: true, trialDays: REFERRAL_TRIAL_DAYS });
  } catch (err) {
    console.error("[REFERRALS] Apply error:", err);
    res.status(500).json({ error: "Failed to apply referral" });
  }
});

// GET /api/referrals/admin/list — admin view of every referral record
router.get("/admin/list", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         r.referrer_email,
         referrer.name AS referrer_name,
         r.referred_email,
         referred.name AS referred_name,
         r.created_at,
         r.converted_at,
         r.referrer_signup_bonus_awarded,
         r.conversion_bonus_awarded
       FROM referrals r
       LEFT JOIN members referrer ON referrer.email = r.referrer_email
       LEFT JOIN members referred ON referred.email = r.referred_email
       ORDER BY r.created_at DESC`
    );

    res.json({
      referrals: rows.map((r) => ({
        referrerEmail: r.referrer_email,
        referrerName: r.referrer_name,
        referredEmail: r.referred_email,
        referredName: r.referred_name,
        createdAt: r.created_at,
        convertedAt: r.converted_at,
        signupBonusAwarded: r.referrer_signup_bonus_awarded,
        conversionBonusAwarded: r.conversion_bonus_awarded,
      })),
    });
  } catch (err) {
    console.error("[REFERRALS] Admin list error:", err);
    res.status(500).json({ error: "Failed to fetch referrals" });
  }
});

// Called when a referred member converts to paid — awards 50 pts to both
export async function checkReferralConversion(memberEmail: string): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT referrer_email FROM referrals
       WHERE referred_email = $1 AND converted_at IS NULL`,
      [memberEmail.toLowerCase()]
    );
    if (rows.length === 0) return;

    const referrerEmail = rows[0].referrer_email;

    await pool.query(
      `UPDATE referrals SET converted_at = now(), conversion_bonus_awarded = TRUE
       WHERE referrer_email = $1 AND referred_email = $2`,
      [referrerEmail, memberEmail.toLowerCase()]
    );

    // Award 50 pts to referrer
    await pool.query(
      `INSERT INTO activity_logs (member_email, activity_type, points, metadata)
       VALUES ($1, 'referral_conversion', $2, $3)`,
      [referrerEmail, CONVERSION_BONUS_POINTS, JSON.stringify({ convertedFriend: memberEmail })]
    );

    // Award 50 pts to the friend who converted
    await pool.query(
      `INSERT INTO activity_logs (member_email, activity_type, points, metadata)
       VALUES ($1, 'referral_conversion', $2, $3)`,
      [memberEmail.toLowerCase(), CONVERSION_BONUS_POINTS, JSON.stringify({ referrer: referrerEmail })]
    );

    sendNotificationToUser(referrerEmail, {
      title: "Your friend subscribed! 🏆",
      body: `Your referral just became a full member — you both earned ${CONVERSION_BONUS_POINTS} points!`,
      tag: "referral",
      url: "/well-cup",
    }).catch(() => {});

    sendNotificationToUser(memberEmail.toLowerCase(), {
      title: "Welcome to the WELL Collective! 🏆",
      body: `You and your friend each earned ${CONVERSION_BONUS_POINTS} bonus points for joining!`,
      tag: "referral",
      url: "/well-cup",
    }).catch(() => {});
  } catch (err) {
    console.error("[REFERRALS] Conversion check error:", err);
  }
}

export default router;
