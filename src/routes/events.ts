import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { broadcastNotification, sendNotificationToUser } from "../push";
import { awardPoints } from "./points";

const router = Router();

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function addWeeks(dateStr: string, weeks: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  date: Date;
  time: string;
  location: string | null;
  color: string;
  rsvps: string[];
  recurrence_group_id: string | null;
  image: string | null;
  sold_out: boolean;
  url: string | null;
  is_well_escape: boolean;
}

function serializeEvent(row: EventRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    date: row.date.toISOString().slice(0, 10),
    time: row.time,
    location: row.location ?? "",
    color: row.color,
    rsvps: row.rsvps ?? [],
    recurrenceGroupId: row.recurrence_group_id ?? undefined,
    image: row.image ?? undefined,
    soldOut: row.sold_out ?? false,
    url: row.url ?? undefined,
    isWellEscape: row.is_well_escape ?? false,
  };
}

router.get("/events", async (req, res) => {
  try {
    const upcomingOnly = req.query.upcoming === "true";
    const light = req.query.light === "true";
    const limitParam = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 250) : null;
    const whereClause = upcomingOnly ? "WHERE date >= CURRENT_DATE" : "";
    const limitClause = limit ? `LIMIT ${limit}` : "";
    const imageSelect = light
      ? "CASE WHEN image IS NOT NULL AND image NOT LIKE 'data:%' THEN image ELSE NULL END AS image"
      : "image";

    const { rows } = await pool.query<EventRow>(
      `SELECT id, title, description, date, time, location, color, rsvps, recurrence_group_id, ${imageSelect}, sold_out, url
       FROM events
       ${whereClause}
       ORDER BY date ASC, time ASC
       ${limitClause}`
    );
    res.json({ events: rows.map(serializeEvent) });
  } catch (err) {
    console.error("Fetch events error:", err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// Creates one event, or — when `recurrence` is set — a whole series of
// weekly occurrences sharing a recurrence_group_id (12 months ahead, ~52
// occurrences), so e.g. "every Tuesday at 9am" only needs to be set up once.
// Only one notification is sent for the whole series, not one per occurrence.
router.post("/events", requireAdmin, async (req, res) => {
  const { title, description, date, time, location, color, image, recurrence, soldOut, url, isWellEscape } = req.body as {
    title?: string;
    description?: string;
    date?: string;
    time?: string;
    location?: string;
    color?: string;
    image?: string;
    recurrence?: { frequency: "weekly"; occurrences?: number };
    soldOut?: boolean;
    url?: string;
    isWellEscape?: boolean;
  };

  if (!title?.trim() || !date || !time?.trim()) {
    return res.status(400).json({ error: "title, date, and time are required" });
  }

  try {
    const dates = [date];
    const recurrenceGroupId = recurrence ? uid("rec") : null;
    if (recurrence?.frequency === "weekly") {
      const occurrenceCount = recurrence.occurrences ?? 52; // ~12 months ahead
      for (let i = 1; i < occurrenceCount; i++) {
        dates.push(addWeeks(date, i));
      }
    }

    const insertedIds: string[] = [];
    for (const occurrenceDate of dates) {
      const id = uid("e");
      insertedIds.push(id);
      await pool.query(
        `INSERT INTO events (id, title, description, date, time, location, color, recurrence_group_id, image, sold_out, url, is_well_escape)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          title.trim(),
          description?.trim() || "",
          occurrenceDate,
          time.trim(),
          location?.trim() || "",
          color || "#0191CE",
          recurrenceGroupId,
          image || null,
          soldOut ?? false,
          url?.trim() || null,
          isWellEscape ?? false,
        ]
      );
    }

    const bodyParts = [time.trim()];
    if (location?.trim()) bodyParts.push(`at ${location.trim()}`);
    if (recurrenceGroupId) bodyParts.push("(repeats weekly)");

    broadcastNotification(
      {
        title: `New Event: ${title.trim()}`,
        body: bodyParts.join(" "),
        tag: "new-event",
        url: "/events",
      },
      { contentPublishedAt: new Date() }
    ).catch((err) => console.error("Event notification failed:", err));

    res.status(201).json({ ok: true, ids: insertedIds, recurrenceGroupId: recurrenceGroupId ?? undefined });
  } catch (err) {
    console.error("Create event error:", err);
    res.status(500).json({ error: "Failed to create event" });
  }
});

router.put("/events/:id", requireAdmin, async (req, res) => {
  const { title, description, date, time, location, color, image, soldOut, url, isWellEscape } = req.body as {
    title?: string;
    description?: string;
    date?: string;
    time?: string;
    location?: string;
    color?: string;
    image?: string;
    soldOut?: boolean;
    url?: string;
    isWellEscape?: boolean;
  };

  if (!title?.trim() || !date || !time?.trim()) {
    return res.status(400).json({ error: "title, date, and time are required" });
  }

  try {
    await pool.query(
      `UPDATE events SET title = $2, description = $3, date = $4, time = $5, location = $6, color = $7, image = $8, sold_out = $9, url = $10, is_well_escape = $11
       WHERE id = $1`,
      [
        req.params.id,
        title.trim(),
        description?.trim() || "",
        date,
        time.trim(),
        location?.trim() || "",
        color || "#0191CE",
        image || null,
        soldOut ?? false,
        url?.trim() || null,
        isWellEscape ?? false,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Update event error:", err);
    res.status(500).json({ error: "Failed to update event" });
  }
});

// Lightweight toggle for the admin list view — flips sold_out without
// requiring the full edit form to be resubmitted.
router.post("/events/:id/sold-out", requireAdmin, async (req, res) => {
  const { soldOut } = req.body as { soldOut?: boolean };
  try {
    await pool.query("UPDATE events SET sold_out = $2 WHERE id = $1", [req.params.id, !!soldOut]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Toggle sold-out error:", err);
    res.status(500).json({ error: "Failed to update event" });
  }
});

// By default deletes just this one occurrence. Pass ?series=true to delete
// every occurrence sharing this event's recurrence_group_id.
router.delete("/events/:id", requireAdmin, async (req, res) => {
  try {
    if (req.query.series === "true") {
      const { rows } = await pool.query<{ recurrence_group_id: string | null }>(
        "SELECT recurrence_group_id FROM events WHERE id = $1",
        [req.params.id]
      );
      const groupId = rows[0]?.recurrence_group_id;
      if (groupId) {
        await pool.query("DELETE FROM events WHERE recurrence_group_id = $1", [groupId]);
      } else {
        await pool.query("DELETE FROM events WHERE id = $1", [req.params.id]);
      }
    } else {
      await pool.query("DELETE FROM events WHERE id = $1", [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete event error:", err);
    res.status(500).json({ error: "Failed to delete event" });
  }
});

router.post("/events/:id/rsvp", async (req, res) => {
  const { memberId, memberEmail } = req.body as { memberId?: string; memberEmail?: string };
  if (!memberId) return res.status(400).json({ error: "memberId required" });

  try {
    const { rows } = await pool.query<{ rsvps: string[] }>("SELECT rsvps FROM events WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Event not found" });

    const rsvps = rows[0].rsvps ?? [];
    const isRemoving = rsvps.includes(memberId);
    const updated = isRemoving ? rsvps.filter((r) => r !== memberId) : [...rsvps, memberId];

    await pool.query("UPDATE events SET rsvps = $2 WHERE id = $1", [req.params.id, updated]);

    if (memberEmail) {
      if (isRemoving) {
        await pool.query("DELETE FROM event_rsvps WHERE event_id = $1 AND member_email = $2", [req.params.id, memberEmail]);
      } else {
        await pool.query(
          "INSERT INTO event_rsvps (event_id, member_email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [req.params.id, memberEmail]
        );
        // Points are awarded by the nightly scheduler AFTER the event date passes,
        // not at RSVP time. This prevents members from farming points by registering
        // and immediately cancelling. Cancelling removes the event_rsvps row so the
        // scheduler skips them automatically.
      }
    }

    res.json({ ok: true, rsvps: updated });
  } catch (err) {
    console.error("RSVP error:", err);
    res.status(500).json({ error: "Failed to update RSVP" });
  }
});

// Toggle RSVP for live events (from lorettabates.com)
router.post("/live-events/:eventId/rsvp", async (req, res) => {
  const { memberId, memberEmail, eventDate } = req.body as { memberId?: string; memberEmail?: string; eventDate?: string };
  const eventId = req.params.eventId;

  if (!memberId) return res.status(400).json({ error: "memberId required" });

  try {
    // Try to fetch existing RSVPs
    const { rows } = await pool.query<{ rsvps: string[] }>(
      "SELECT rsvps FROM live_event_rsvps WHERE event_id = $1",
      [eventId]
    );

    let rsvps = rows.length > 0 ? (rows[0].rsvps ?? []) : [];
    const isRemoving = rsvps.includes(memberId);
    const updated = isRemoving ? rsvps.filter((r) => r !== memberId) : [...rsvps, memberId];

    // Insert or update
    if (rows.length === 0) {
      await pool.query(
        "INSERT INTO live_event_rsvps (event_id, rsvps) VALUES ($1, $2)",
        [eventId, updated]
      );
    } else {
      await pool.query("UPDATE live_event_rsvps SET rsvps = $2 WHERE event_id = $1", [eventId, updated]);
    }

    // Also track by email in event_rsvps so the nightly scheduler can award points
    if (memberEmail) {
      if (isRemoving) {
        await pool.query(
          "DELETE FROM event_rsvps WHERE event_id = $1 AND member_email = $2",
          [eventId, memberEmail.toLowerCase()]
        );
      } else {
        await pool.query(
          `INSERT INTO event_rsvps (event_id, member_email, event_date)
           VALUES ($1, $2, $3)
           ON CONFLICT (event_id, member_email) DO NOTHING`,
          [eventId, memberEmail.toLowerCase(), eventDate ?? null]
        );
      }
    }

    res.json({ ok: true, rsvps: updated });
  } catch (err) {
    console.error("Live event RSVP error:", err);
    res.status(500).json({ error: "Failed to update RSVP" });
  }
});

// Get RSVPs for live events
router.get("/live-events/rsvps/:eventId", async (req, res) => {
  const eventId = req.params.eventId;

  try {
    const { rows } = await pool.query<{ rsvps: string[] }>(
      "SELECT rsvps FROM live_event_rsvps WHERE event_id = $1",
      [eventId]
    );

    const rsvps = rows.length > 0 ? (rows[0].rsvps ?? []) : [];
    res.json({ rsvps });
  } catch (err) {
    console.error("Fetch live event RSVPs error:", err);
    res.status(500).json({ error: "Failed to fetch RSVPs" });
  }
});

// Admin: fetch member details for all RSVPs on an event (used for WELL Escape point awarder)
router.get("/events/:id/rsvp-members", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.email, m.name, m.avatar
       FROM event_rsvps er
       JOIN members m ON m.email = er.member_email
       WHERE er.event_id = $1
       ORDER BY m.name ASC`,
      [req.params.id]
    );
    res.json({ members: rows });
  } catch (err) {
    console.error("RSVP members error:", err);
    res.status(500).json({ error: "Failed to fetch RSVP members" });
  }
});

// Admin: award 100 WELL Escape points + push notification to selected members
router.post("/events/well-escape-award", requireAdmin, async (req, res) => {
  const { eventTitle, emails } = req.body as { eventTitle?: string; emails?: string[] };
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: "emails array required" });
  }

  const results: { email: string; awarded: boolean }[] = [];
  for (const raw of emails) {
    const email = raw.toLowerCase().trim();

    // Dedup per event: skip if this member already has a well_escape log for this exact event title
    const { rows: existing } = await pool.query(
      `SELECT id FROM activity_logs
       WHERE member_email = $1
         AND activity_type = 'well_escape'
         AND metadata->>'eventTitle' = $2
       LIMIT 1`,
      [email, eventTitle ?? ""]
    );
    if (existing.length > 0) {
      results.push({ email, awarded: false });
      console.log(`[WELL ESCAPE] Skipped (already earned for this event) ${email}`);
      continue;
    }

    const { awarded } = await awardPoints(email, "well_escape", { eventTitle });
    if (awarded) {
      sendNotificationToUser(email, {
        title: "You earned 100 WELL Escape points!",
        body: eventTitle
          ? `Thank you for attending ${eventTitle}. Your points have been added to the WELL Cup.`
          : "Your WELL Escape retreat points have been added to the WELL Cup.",
        tag: "well-escape",
        url: "/well-cup",
      }).catch(() => {});
    }
    results.push({ email, awarded });
    console.log(`[WELL ESCAPE] ${awarded ? "Awarded" : "Skipped (no member found)"} 100 pts for ${email}`);
  }

  res.json({ ok: true, results });
});

// Remove duplicate well_escape points — keeps the first entry per member per event, deletes extras
router.post("/events/well-escape-fix-duplicates", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      DELETE FROM activity_logs
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY member_email, activity_type, metadata->>'eventTitle'
                   ORDER BY created_at ASC
                 ) AS rn
          FROM activity_logs
          WHERE activity_type = 'well_escape'
        ) ranked
        WHERE rn > 1
      )
      RETURNING member_email, metadata->>'eventTitle' AS event_title
    `);
    console.log(`[WELL ESCAPE FIX] Removed ${rows.length} duplicate entries`);
    res.json({ ok: true, removed: rows.length, details: rows });
  } catch (err) {
    console.error("[WELL ESCAPE FIX] Error:", err);
    res.status(500).json({ error: "Failed to fix duplicates" });
  }
});

export default router;
