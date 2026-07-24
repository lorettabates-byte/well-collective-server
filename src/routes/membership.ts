import { Router } from "express";
import { verifyMembership } from "../membership";
import { checkReferralConversion } from "./referrals";
import { pool } from "../db";

const router = Router();

const WORDPRESS_URL = process.env.WORDPRESS_URL || "https://lorettabates.com";
const WELL_API_KEY = process.env.WELL_API_KEY || "";

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

  const active = await verifyMembership(email);

  // When a member is verified as active via UMP, check if they were referred
  // and award conversion bonuses if not already awarded.
  if (active) {
    const { rows } = await pool.query(
      "SELECT membership_status FROM members WHERE email = $1",
      [email.toLowerCase()]
    );
    const prev = rows[0]?.membership_status;
    if (prev !== "active") {
      await pool.query(
        "UPDATE members SET membership_status = 'active' WHERE email = $1",
        [email.toLowerCase()]
      ).catch(() => {});
      checkReferralConversion(email).catch((err) =>
        console.error("Referral conversion check error:", err)
      );
    }
  }

  res.json({ active });
});

export default router;
