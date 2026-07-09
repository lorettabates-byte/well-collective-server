import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { broadcastNotification } from "../push";

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
      `SELECT id, title, description, date, time, location, color, rsvps, recurrence_group_id, ${imageSelect}, sold_out
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
  const { title, description, date, time, location, color, image, recurrence, soldOut } = req.body as {
    title?: string;
    description?: string;
    date?: string;
    time?: string;
    location?: string;
    color?: string;
    image?: string;
    recurrence?: { frequency: "weekly"; occurrences?: number };
    soldOut?: boolean;
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
        `INSERT INTO events (id, title, description, date, time, location, color, recurrence_group_id, image, sold_out)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
  const { title, description, date, time, location, color, image, soldOut } = req.body as {
    title?: string;
    description?: string;
    date?: string;
    time?: string;
    location?: string;
    color?: string;
    image?: string;
    soldOut?: boolean;
  };

  if (!title?.trim() || !date || !time?.trim()) {
    return res.status(400).json({ error: "title, date, and time are required" });
  }

  try {
    await pool.query(
      `UPDATE events SET title = $2, description = $3, date = $4, time = $5, location = $6, color = $7, image = $8, sold_out = $9
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
  const { memberId, memberEmail } = req.body as { memberId?: string; memberEmail?: string };
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

export default router;
