import { Router } from "express";
import { pool } from "../db";
import type { PushSubscriptionRecord } from "../types";

const router = Router();

router.post("/subscribe", async (req, res) => {
  const sub = req.body as PushSubscriptionRecord;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: "Invalid subscription" });
  }

  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = $2, auth = $3`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );

  res.status(201).json({ ok: true });
});

router.post("/unsubscribe", async (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });

  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
  res.json({ ok: true });
});

export default router;
