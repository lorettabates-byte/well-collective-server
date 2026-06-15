import { Router } from "express";
import { verifyMembership } from "../membership";

const router = Router();

router.get("/membership/status", async (req, res) => {
  const email = (req.query.email as string | undefined)?.trim();
  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  const active = await verifyMembership(email);
  res.json({ active });
});

export default router;
