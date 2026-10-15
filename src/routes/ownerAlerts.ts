import crypto from "crypto";
import { Router } from "express";
import { ADMIN_NOTIFY_EMAILS, sendNotificationToUser } from "../push";

const router = Router();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// The WELL Collective website (mu-plugin well-wc-comment-alert.php) posts here when a
// member leaves a comment on a class, so Loretta gets a push on her phone right away.
router.post("/owner-alerts/comment", async (req, res) => {
  const key = process.env.WELL_API_KEY || "";
  if (!key || !safeEqual(req.header("X-WELL-API-KEY") || "", key)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const b = req.body as { author?: string; post_title?: string; excerpt?: string; url?: string; waiting?: boolean };
  const author = (b.author || "Someone").slice(0, 60);
  const where = (b.post_title || "a class").slice(0, 80);
  const excerpt = (b.excerpt || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const title = b.waiting ? `New comment waiting for your OK` : `New comment from ${author}`;
  const body = `${b.waiting ? author + " on " : "On "}${where}: "${excerpt}"`;
  const url = typeof b.url === "string" && b.url.startsWith("https://lorettabates.com/") ? b.url : undefined;
  let sent = 0;
  for (const admin of ADMIN_NOTIFY_EMAILS) {
    const r = await sendNotificationToUser(admin, { title, body, tag: "new-comment", url });
    sent += r.sent;
  }
  res.json({ ok: true, sent });
});

export default router;
