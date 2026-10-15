import crypto from "crypto";
import express, { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { getPaidMembers } from "../paidMembers";
import {
  REASONS,
  SOURCE_LABEL,
  STORE_REASON_LABEL,
  emailFromReasonToken,
  ensureMembershipTables,
  recordMembershipEvent,
  saveCancelReason,
  tenureText,
  type Source,
} from "../membershipEvents";

const router = Router();
const TZ = "America/New_York";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// RevenueCat webhook: App Store and Google Play joins and cancellations, live.
// Set up in RevenueCat > Integrations > Webhooks with the REVENUECAT_WEBHOOK_SECRET
// value as the Authorization header.
// ---------------------------------------------------------------------------
interface RcEvent {
  type?: string;
  environment?: string;
  store?: string;
  period_type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  subscriber_attributes?: Record<string, { value?: string }>;
  event_timestamp_ms?: number;
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  cancel_reason?: string;
  is_trial_conversion?: boolean;
}

function rcEmail(e: RcEvent): string | null {
  const candidates = [e.app_user_id, e.original_app_user_id, ...(e.aliases ?? []), e.subscriber_attributes?.$email?.value];
  const hit = candidates.find((c) => typeof c === "string" && c.includes("@"));
  return hit ? hit.trim().toLowerCase() : null;
}

router.post("/webhooks/revenuecat", async (req, res) => {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET || "";
  const got = (req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || !safeEqual(got, secret.replace(/^Bearer\s+/i, ""))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const e = ((req.body as { event?: RcEvent })?.event ?? {}) as RcEvent;
  res.json({ ok: true }); // RevenueCat retries on non-200; answer first, then record.

  try {
    if (e.type === "TEST" || e.environment === "SANDBOX") return;
    const source: Source | null = e.store === "APP_STORE" ? "app_store" : e.store === "PLAY_STORE" ? "google_play" : null;
    const email = rcEmail(e);
    if (!source || !email) return;
    const at = (ms?: number | null) => (ms ? new Date(ms) : new Date());
    const trial = e.period_type === "TRIAL";

    if ((e.type === "INITIAL_PURCHASE" && !trial) || (e.type === "RENEWAL" && e.is_trial_conversion)) {
      await recordMembershipEvent({ email, kind: "joined", source, via: "revenuecat_webhook", occurredAt: at(e.purchased_at_ms ?? e.event_timestamp_ms) });
    } else if (e.type === "CANCELLATION" && !trial) {
      await recordMembershipEvent({
        email, kind: "cancelled", source, via: "revenuecat_webhook", occurredAt: at(e.event_timestamp_ms),
        accessUntil: e.expiration_at_ms ? new Date(e.expiration_at_ms) : null, storeReason: e.cancel_reason ?? null,
      });
    } else if (e.type === "UNCANCELLATION") {
      await recordMembershipEvent({ email, kind: "resumed", source, via: "revenuecat_webhook", occurredAt: at(e.event_timestamp_ms) });
    } else if (e.type === "EXPIRATION" && !trial) {
      await recordMembershipEvent({ email, kind: "ended", source, via: "revenuecat_webhook", occurredAt: at(e.expiration_at_ms ?? e.event_timestamp_ms), notify: false });
    }
  } catch (err) {
    console.error("[MEMBERSHIP] RevenueCat webhook error:", err);
  }
});

// ---------------------------------------------------------------------------
// Website (Ultimate Membership Pro): the WordPress mu-plugin posts cancels and
// paid orders here the moment they happen, with the member's UMP cancel reason.
// ---------------------------------------------------------------------------
router.post("/membership-events/website", async (req, res) => {
  const key = process.env.WELL_API_KEY || "";
  if (!key || !safeEqual(req.header("X-WELL-API-KEY") || "", key)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const b = req.body as {
    email?: string; name?: string; kind?: string; gateway?: string;
    started_at?: string; access_until?: string; reason?: string; note?: string;
  };
  const email = (b.email || "").trim().toLowerCase();
  if (!email.includes("@") || !["joined", "cancelled"].includes(b.kind || "")) {
    res.status(400).json({ error: "email and kind (joined|cancelled) are required" });
    return;
  }
  try {
    if (b.reason && b.reason in REASONS) await saveCancelReason(email, b.reason, b.note ?? null, "website");
    const d = (v?: string) => (v ? new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z") : null);
    const recorded = await recordMembershipEvent({
      email, name: b.name, kind: b.kind as "joined" | "cancelled", source: "website", gateway: b.gateway || null,
      via: "website_hook", memberSince: d(b.started_at), accessUntil: d(b.access_until),
    });
    res.json({ ok: true, recorded });
  } catch (err) {
    console.error("[MEMBERSHIP] website event error:", err);
    res.status(500).json({ error: "Could not record" });
  }
});

// ---------------------------------------------------------------------------
// Why are you leaving: from the app (before it sends them to the store) and
// from the one-tap links in the email.
// ---------------------------------------------------------------------------
router.post("/membership/cancel-reason", async (req, res) => {
  const { email, reason, note } = req.body as { email?: string; reason?: string; note?: string };
  if (!email || !reason || !(reason in REASONS)) {
    res.status(400).json({ error: "email and a valid reason are required" });
    return;
  }
  const ok = await saveCancelReason(email, reason, note ?? null, "app").catch(() => false);
  res.status(ok ? 200 : 400).json({ ok });
});

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en" style="color-scheme:dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{margin:0;background:#020810;color:#c9d9e6;font:17px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:48px 20px}
h1{font-family:Georgia,'Times New Roman',serif;font-weight:600;color:#fff;font-size:34px;line-height:1.15;margin:0 0 16px}
em{color:#84D8FD}
textarea{width:100%;box-sizing:border-box;min-height:120px;background:#0a1624;color:#fff;border:1px solid rgba(132,216,253,.35);border-radius:12px;padding:12px;font:inherit}
button{margin-top:14px;background:#0191CE;color:#fff;border:0;border-radius:10px;padding:13px 22px;font:inherit;font-weight:700}
.sig{font-family:Georgia,serif;font-style:italic;color:#fff;font-size:22px;margin-top:28px}
</style></head><body><main>${body}</main></body></html>`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

router.get("/cancel-reason", async (req, res) => {
  const email = emailFromReasonToken(String(req.query.t || ""));
  const reason = String(req.query.r || "");
  if (!email || !(reason in REASONS)) {
    res.status(400).send(page("Link expired", "<h1>Hmm, that link didn't work</h1><p>Just reply to my email and tell me in a sentence. It comes straight to me.</p>"));
    return;
  }
  await saveCancelReason(email, reason, null, "email");
  const t = esc(String(req.query.t));
  res.send(page("Thank you", `<h1>Thank you, <em>truly</em>.</h1>
<p>You picked: <strong style="color:#fff">${esc(REASONS[reason])}</strong>. That helps me SO much.</p>
<p>Anything you want to add? It's optional, and I read every word.</p>
<form method="post" action="/api/cancel-reason"><input type="hidden" name="t" value="${t}"><input type="hidden" name="r" value="${esc(reason)}">
<textarea name="note" maxlength="1000" placeholder="Tell me more (optional)"></textarea><button type="submit">Send to Loretta</button></form>
<p class="sig">With love,<br>Loretta</p>`));
});

router.post("/cancel-reason", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
  const { t, r, note } = req.body as { t?: string; r?: string; note?: string };
  const email = emailFromReasonToken(String(t || ""));
  if (!email || !r || !(r in REASONS)) {
    res.status(400).send(page("Link expired", "<h1>Hmm, that didn't work</h1><p>Just reply to my email instead. It comes straight to me.</p>"));
    return;
  }
  await saveCancelReason(email, r, note ?? null, "email");
  res.send(page("Thank you", `<h1>Got it. <em>Thank you!</em></h1><p>Your door is always open. Come dance with me anytime!</p><p class="sig">With love,<br>Loretta</p>`));
});

// ---------------------------------------------------------------------------
// Owner report: joins, cancellations and endings for one month, with reasons.
// ---------------------------------------------------------------------------
interface EventRow {
  email: string; name: string | null; kind: string; source: Source; gateway: string | null;
  occurred_at: Date; member_since: Date | null; access_until: Date | null; store_reason: string | null;
}

router.get("/analytics/membership-movement", requireAdmin, async (req, res) => {
  try {
    await ensureMembershipTables();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ""))
      ? String(req.query.month)
      : new Date().toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 7);

    const { rows } = await pool.query<EventRow>(
      `SELECT email, name, kind, source, gateway, occurred_at, member_since, access_until, store_reason
         FROM membership_events
        WHERE date_known
          AND (occurred_at AT TIME ZONE '${TZ}') >= ($1 || '-01')::date
          AND (occurred_at AT TIME ZONE '${TZ}') < (($1 || '-01')::date + interval '1 month')
        ORDER BY occurred_at DESC`,
      [month]
    );
    const reasonsRes = await pool.query<{ email: string; reason: string; note: string | null; asked_via: string; created_at: Date }>(
      `SELECT email, reason, note, asked_via, created_at FROM cancel_reasons
        WHERE created_at > ($1 || '-01')::date - interval '15 days'
          AND created_at < ($1 || '-01')::date + interval '1 month' + interval '15 days'
        ORDER BY created_at DESC`,
      [month]
    );
    const reasonFor = (email: string, at: Date) =>
      reasonsRes.rows.find((r) => r.email === email && Math.abs(r.created_at.getTime() - at.getTime()) < 15 * 86_400_000) ?? null;

    const shape = (r: EventRow) => {
      const answer = r.kind === "cancelled" || r.kind === "ended" ? reasonFor(r.email, r.occurred_at) : null;
      return {
        name: r.name || r.email.split("@")[0],
        email: r.email,
        source: r.source,
        sourceLabel: SOURCE_LABEL[r.source] + (r.gateway ? ` (${r.gateway})` : ""),
        date: r.occurred_at.toISOString(),
        memberSince: r.member_since?.toISOString() ?? null,
        tenure: r.kind === "joined" ? null : tenureText(r.member_since, r.occurred_at),
        accessUntil: r.access_until?.toISOString() ?? null,
        storeReason: r.store_reason ? STORE_REASON_LABEL[r.store_reason] ?? r.store_reason : null,
        reason: answer ? REASONS[answer.reason] ?? answer.reason : null,
        note: answer?.note ?? null,
        askedVia: answer?.asked_via ?? null,
      };
    };

    const sources: Source[] = ["website", "app_store", "google_play"];
    const count = (kind: string) => {
      const out: Record<string, number> = { total: 0 };
      for (const s of sources) out[s] = rows.filter((r) => r.kind === kind && r.source === s).length;
      out.total = sources.reduce((n, s) => n + out[s], 0);
      return out;
    };

    const monthStart = new Date(`${month}-01T12:00:00Z`).getTime();
    const monthEnd = monthStart + 31 * 86_400_000;
    const inMonth = reasonsRes.rows.filter((r) => r.created_at.getTime() >= monthStart - 86_400_000 && r.created_at.getTime() < monthEnd);
    const reasons = Object.entries(REASONS)
      .map(([key, label]) => ({ key, label, count: inMonth.filter((r) => r.reason === key).length }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);

    const monthsRes = await pool.query<{ m: string }>(
      `SELECT DISTINCT to_char(occurred_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS m FROM membership_events WHERE date_known ORDER BY m DESC`
    );
    const paid = await getPaidMembers().catch(() => null);

    res.json({
      month,
      months: Array.from(new Set([month, ...monthsRes.rows.map((r) => r.m)])).sort().reverse(),
      counts: { joined: count("joined"), cancelled: count("cancelled"), ended: count("ended"), resumed: count("resumed") },
      activeNow: paid ? { website: paid.website.size, app_store: paid.apple.size, google_play: paid.play.size, total: paid.website.size + paid.apple.size + paid.play.size } : null,
      joined: rows.filter((r) => r.kind === "joined").map(shape),
      cancelled: rows.filter((r) => r.kind === "cancelled").map(shape),
      ended: rows.filter((r) => r.kind === "ended").map(shape),
      reasons,
      reasonNotes: inMonth.filter((r) => r.note).map((r) => ({ reason: REASONS[r.reason] ?? r.reason, note: r.note, date: r.created_at.toISOString() })),
    });
  } catch (err) {
    console.error("[MEMBERSHIP] report error:", err);
    res.status(500).json({ error: "Could not build the report" });
  }
});

export default router;
