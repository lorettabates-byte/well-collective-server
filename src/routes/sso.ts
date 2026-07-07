import { Router } from "express";
import crypto from "crypto";

const router = Router();

const SSO_SECRET = process.env.SSO_SECRET || "";
const LINK_TTL_MS = 2 * 60 * 1000; // 2 minutes — link must be used almost immediately

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// GET /api/sso/link?email=X&redirect=Y
// Returns a signed, short-lived WordPress auto-login URL so a member who is
// already authenticated in the app doesn't hit a separate WordPress login
// wall when tapping a class/blog/event link that points at lorettabates.com.
router.get("/link", (req, res): void => {
  const email = (req.query.email as string | undefined)?.trim().toLowerCase();
  const redirect = (req.query.redirect as string | undefined)?.trim();

  if (!email || !redirect) {
    res.status(400).json({ error: "email and redirect are required" });
    return;
  }
  if (!redirect.startsWith("https://lorettabates.com")) {
    res.status(400).json({ error: "redirect must be a lorettabates.com URL" });
    return;
  }
  if (!SSO_SECRET) {
    // Not configured yet — fail open by returning the plain redirect so
    // links still work, just without the auto-login.
    res.json({ url: redirect });
    return;
  }

  const payload = { email, redirect, exp: Math.floor((Date.now() + LINK_TTL_MS) / 1000) };
  const token = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.createHmac("sha256", SSO_SECRET).update(token).digest("hex");

  const url = `${redirect.split("?")[0]}${redirect.includes("?") ? "&" : "?"}well_sso=${encodeURIComponent(token)}&well_sig=${sig}`;
  res.json({ url });
});

export default router;
