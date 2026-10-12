import { Router } from "express";
import { addDays } from "../dateUtils";
import { requireAdmin } from "../middleware/adminAuth";
import {
  bannerText,
  chooseReplacement,
  recordReplacement,
  isDate,
  isTime,
  listUpcoming,
  listWithLog,
  planPushes,
  processDueClassCancellationPushes,
  removeCancellation,
  saveCancellation,
  sendTest,
  type Cancellation,
} from "../classCancellations";

const router = Router();

// Leave `replacement` out to have the server pick a recorded class (rotating,
// never repeated). Send an object to choose one yourself.
function parseBody(body: Record<string, unknown>): { c?: Cancellation; auto?: boolean; error?: string } {
  const { date, time, back_on, back_time, replacement } = body;
  if (!isDate(date)) return { error: "date is required as YYYY-MM-DD" };
  if (time !== undefined && !isTime(time)) return { error: "time must be HH:MM (24-hour, Eastern)" };
  if (!isDate(back_on)) return { error: "back_on is required as YYYY-MM-DD" };
  if (back_on <= date) return { error: "back_on must be after date" };
  if (back_time !== undefined && !isTime(back_time)) return { error: "back_time must be HH:MM (24-hour, Eastern)" };

  let rep: Cancellation["replacement"] = null;
  if (replacement != null) {
    const r = replacement as { title?: unknown; url?: unknown };
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!title || !/^https:\/\//.test(url)) {
      return { error: "replacement needs a title and an https url" };
    }
    rep = { title, url };
  }
  const classTime = (time as string | undefined) ?? "09:00";
  return {
    c: { date, time: classTime, back_on, back_time: (back_time as string | undefined) ?? classTime, replacement: rep },
    auto: replacement == null,
  };
}

// Save or update a cancellation (Command Center). `test: true` sends both
// pushes to Loretta only, right now, and saves nothing.
router.post("/admin/class-cancellations", requireAdmin, async (req, res) => {
  const { c, auto, error } = parseBody(req.body ?? {});
  if (!c) return res.status(400).json({ ok: false, error });

  try {
    const plan = await planPushes(c);
    let pick: Awaited<ReturnType<typeof chooseReplacement>> = null;
    if (auto) {
      pick = await chooseReplacement(c.date).catch((err) => {
        console.error("[CLASS CANCEL] Could not pick a replacement class:", err);
        return null;
      });
      if (pick) c.replacement = { title: pick.title, url: pick.url };
    }
    if (req.body.test === true) {
      const result = await sendTest(c);
      return res.json({
        ok: true,
        test: true,
        ...result,
        banner: bannerText(c),
        replacement: c.replacement,
        replacement_auto: !!pick,
        would_schedule: plan.map((p) => ({
          kind: p.kind,
          send_at: p.send_at?.toISOString() ?? null,
          ...(p.reason ? { skipped: p.reason } : {}),
        })),
      });
    }

    if (plan.every((p) => p.reason === "class time has passed")) {
      return res.status(400).json({ ok: false, error: "That class time has already passed" });
    }
    const saved = await saveCancellation(c);
    if (pick) await recordReplacement(c.date, pick);
    processDueClassCancellationPushes().catch((err) => console.error("[CLASS CANCEL] Immediate send failed:", err));
    res.json({ ok: true, date: c.date, banner: bannerText(c), replacement: c.replacement, replacement_auto: !!pick, ...saved });
  } catch (err) {
    console.error("Save class cancellation error:", err);
    res.status(500).json({ ok: false, error: "Failed to save class cancellation" });
  }
});

// Cancellations with their push log ("sent to N members").
router.get("/admin/class-cancellations", requireAdmin, async (_req, res) => {
  try {
    res.json({ ok: true, cancellations: await listWithLog() });
  } catch (err) {
    console.error("List class cancellations error:", err);
    res.status(500).json({ ok: false, error: "Failed to list class cancellations" });
  }
});

router.delete("/admin/class-cancellations/:date", requireAdmin, async (req, res) => {
  if (!isDate(req.params.date)) return res.status(400).json({ ok: false, error: "date must be YYYY-MM-DD" });
  try {
    const result = await removeCancellation(req.params.date);
    res.json({ ok: true, date: req.params.date, ...result });
  } catch (err) {
    console.error("Delete class cancellation error:", err);
    res.status(500).json({ ok: false, error: "Failed to remove class cancellation" });
  }
});

// Public: what the app shows (banner, replacement button, hidden livestream).
router.get("/class-cancellations", async (_req, res) => {
  try {
    const list = await listUpcoming();
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      // banner_from: the app shows the banner from 6 days before the class
      // (Loretta, 2026-10-12). The livestream is hidden for the whole time.
      cancellations: list.map((c) => ({ ...c, banner: bannerText(c), banner_from: addDays(c.date, -6) })),
    });
  } catch (err) {
    console.error("Public class cancellations error:", err);
    res.status(500).json({ cancellations: [] });
  }
});

export default router;
