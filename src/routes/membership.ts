import { Router } from "express";
import { verifyMembership } from "../membership";
import { checkReferralConversion } from "./referrals";
import { pool } from "../db";

const router = Router();

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
