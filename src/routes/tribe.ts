import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { sendNotificationToUser } from "../push";
import { computeBonusBadges, computeLevelBadge } from "../badges";
import { awardPoints } from "./points";
import { deriveMemberId, findEmailByMemberId } from "../utils/memberUtils";

const router = Router();

// Mirrors TRIBE_CHEERS in the client's src/data/cheers.ts — kept as a server
// whitelist so the notification text can't be spoofed by an arbitrary
// client-supplied string.
const TRIBE_CHEER_LABELS: Record<string, string> = {
  "crushing-it": "Crushing It!",
  "proud-of-you": "Proud of You!",
  "keep-going": "Keep Going!",
  "you-inspire-me": "You Inspire Me!",
  "thinking-of-you": "Thinking of You!",
  "youre-amazing": "You're Amazing!",
  "way-to-go": "Way to Go!",
  "happy-birthday": "Happy Birthday! Wishing you a wonderful day!",
};

// Admin: list all tribe connections (diagnostic / restore tool)
router.get("/admin/tribe-connections", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.owner_email, om.name AS owner_name,
              t.member_email, mm.name AS member_name
       FROM tribe_members t
       LEFT JOIN members om ON om.email = t.owner_email
       LEFT JOIN members mm ON mm.email = t.member_email
       ORDER BY t.owner_email, t.member_email`
    );
    res.json({ connections: rows });
  } catch (err) {
    console.error("Admin tribe connections error:", err);
    res.status(500).json({ error: "Failed to fetch tribe connections" });
  }
});

// Admin: silently add a tribe connection (no push notification sent).
// Used to restore tribe connections that were lost due to account deletions.
router.post("/admin/tribe-connections", requireAdmin, async (req, res) => {
  const { ownerEmail, memberEmail } = req.body as { ownerEmail?: string; memberEmail?: string };
  if (!ownerEmail || !memberEmail) {
    return res.status(400).json({ error: "ownerEmail and memberEmail required" });
  }
  const oe = ownerEmail.toLowerCase().trim();
  const me = memberEmail.toLowerCase().trim();
  if (oe === me) return res.status(400).json({ error: "Owner and member must be different" });

  try {
    // Ensure both accounts exist — create minimal stubs if missing so the
    // connection can be recorded even if the member hasn't synced yet.
    await pool.query(
      "INSERT INTO members (email, name) VALUES ($1, $1) ON CONFLICT (email) DO NOTHING",
      [me]
    );
    await pool.query(
      "INSERT INTO tribe_members (owner_email, member_email) VALUES ($1, $2) ON CONFLICT (owner_email, member_email) DO NOTHING",
      [oe, me]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Admin add tribe connection error:", err);
    res.status(500).json({ error: "Failed to add tribe connection" });
  }
});

// Admin: remove a tribe connection
router.delete("/admin/tribe-connections", requireAdmin, async (req, res) => {
  const { ownerEmail, memberEmail } = req.body as { ownerEmail?: string; memberEmail?: string };
  if (!ownerEmail || !memberEmail) {
    return res.status(400).json({ error: "ownerEmail and memberEmail required" });
  }
  try {
    await pool.query(
      "DELETE FROM tribe_members WHERE owner_email = $1 AND member_email = $2",
      [ownerEmail.toLowerCase().trim(), memberEmail.toLowerCase().trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin remove tribe connection error:", err);
    res.status(500).json({ error: "Failed to remove tribe connection" });
  }
});

// Get a member's WELL Tribe
router.get("/tribe", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  try {
    // LEFT JOIN so that if a member was deleted from the members table their
    // tribe row still surfaces (with nulls) rather than silently vanishing.
    const { rows } = await pool.query(
      `SELECT t.member_email AS email,
              COALESCE(m.name, '[Removed Member]') AS name,
              m.avatar, m.workout_log, m.featured_badge, m.created_at,
              CASE WHEN m.show_birthday_on_calendar THEN m.birthday ELSE NULL END AS birthday,
              CASE WHEN m.mood_status_expires_at > NOW() THEN m.mood_status ELSE NULL END AS mood_status
       FROM tribe_members t
       LEFT JOIN members m ON m.email = t.member_email
       WHERE t.owner_email = $1
       ORDER BY t.member_email ASC`,
      [email]
    );

    const emails = rows.map((row) => row.email);
    const ids = emails.map(deriveMemberId);

    const { rows: msgCountRows } = await pool.query(
      "SELECT author_id, COUNT(*) FROM forum_messages WHERE author_id = ANY($1) GROUP BY author_id",
      [ids]
    );
    const msgCountByAuthorId = new Map(msgCountRows.map((r) => [r.author_id, Number(r.count)]));

    const { rows: cheerCountRows } = await pool.query(
      "SELECT sender_email, COUNT(*) FROM tribe_cheers WHERE sender_email = ANY($1) GROUP BY sender_email",
      [emails]
    );
    const cheerCountByEmail = new Map(cheerCountRows.map((r) => [r.sender_email, Number(r.count)]));

    // When did the current viewer last cheer each tribe member?
    const { rows: lastCheeredRows } = await pool.query(
      "SELECT recipient_email, MAX(created_at) AS last_cheered_at FROM tribe_cheers WHERE sender_email = $1 GROUP BY recipient_email",
      [email]
    );
    const lastCheeredByEmail = new Map(lastCheeredRows.map((r) => [r.recipient_email, r.last_cheered_at as string]));

    const { rows: badgeRows } = await pool.query(
      "SELECT member_email, badge_id FROM member_badges WHERE member_email = ANY($1)",
      [emails]
    );
    const badgesByEmail = new Map<string, string[]>();
    for (const b of badgeRows) {
      badgesByEmail.set(b.member_email, [...(badgesByEmail.get(b.member_email) ?? []), b.badge_id]);
    }

    res.json({
      tribe: rows.map((row) => {
        const id = deriveMemberId(row.email);
        const workoutLog = row.workout_log ?? [];
        const messageCount = msgCountByAuthorId.get(id) ?? 0;
        return {
          id,
          name: row.name,
          avatar: row.avatar ?? undefined,
          birthday: row.birthday ?? undefined,
          workoutLog,
          levelBadge: computeLevelBadge(messageCount, workoutLog.length),
          bonusBadges: computeBonusBadges(row.created_at, messageCount, cheerCountByEmail.get(row.email) ?? 0),
          grantedBadges: badgesByEmail.get(row.email) ?? [],
          featuredBadge: row.featured_badge ?? undefined,
          lastCheeredAt: lastCheeredByEmail.get(row.email) ?? null,
          moodStatus: row.mood_status ?? null,
        };
      }),
    });
  } catch (err) {
    console.error("Fetch WELL Tribe error:", err);
    res.status(500).json({ error: "Failed to fetch WELL Tribe" });
  }
});

// Add a member to the caller's WELL Tribe
router.post("/tribe", async (req, res) => {
  const { email, memberId } = req.body as { email?: string; memberId?: string };
  if (!email || !memberId) {
    return res.status(400).json({ error: "email and memberId required" });
  }

  const ownerEmail = email.toLowerCase();

  try {
    const targetEmail = await findEmailByMemberId(memberId);
    console.log(`[tribe] add: owner=${ownerEmail} memberId=${memberId} resolved=${targetEmail ?? "null"}`);
    if (!targetEmail) {
      return res.status(404).json({ error: "Member not found" });
    }
    if (targetEmail.toLowerCase() === ownerEmail) {
      return res.status(400).json({ error: "Cannot add yourself to your own WELL Tribe" });
    }

    const { rows: insertRows } = await pool.query(
      `INSERT INTO tribe_members (owner_email, member_email) VALUES ($1, $2)
       ON CONFLICT (owner_email, member_email) DO NOTHING
       RETURNING owner_email`,
      [ownerEmail, targetEmail.toLowerCase()]
    );

    // Only award points if this was a new addition (not a duplicate)
    if (insertRows.length > 0) {
      awardPoints(ownerEmail, "tribe_add").catch(() => {});
    }

    const { rows: ownerRows } = await pool.query("SELECT name FROM members WHERE email = $1", [ownerEmail]);
    const ownerName = ownerRows[0]?.name || "Someone";

    sendNotificationToUser(targetEmail, {
      title: "WELL Tribe",
      body: `${ownerName} added you to their WELL Tribe!`,
      tag: "tribe",
      url: "/tribe",
    }).catch((err) => console.error("Failed to send WELL Tribe notification:", err));

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Add to WELL Tribe error:", err);
    res.status(500).json({ error: "Failed to add to WELL Tribe" });
  }
});

// Remove a member from the caller's WELL Tribe
router.delete("/tribe/:memberId", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  try {
    const targetEmail = await findEmailByMemberId(req.params.memberId);
    if (!targetEmail) {
      return res.status(404).json({ error: "Member not found" });
    }

    await pool.query("DELETE FROM tribe_members WHERE owner_email = $1 AND member_email = $2", [
      email,
      targetEmail.toLowerCase(),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error("Remove from WELL Tribe error:", err);
    res.status(500).json({ error: "Failed to remove from WELL Tribe" });
  }
});

// Send one of the 3 fixed WELL Tribe cheers to a tribe member.
router.post("/tribe/:memberId/cheer", async (req, res) => {
  const { email, cheerId } = req.body as { email?: string; cheerId?: string };
  const cheerLabel = cheerId ? TRIBE_CHEER_LABELS[cheerId] : undefined;

  if (!email || !cheerLabel) {
    return res.status(400).json({ error: "email and a valid cheerId required" });
  }

  const senderEmail = email.toLowerCase();

  try {
    const targetEmail = await findEmailByMemberId(req.params.memberId);
    if (!targetEmail) {
      return res.status(404).json({ error: "Member not found" });
    }

    await pool.query(
      "INSERT INTO tribe_cheers (sender_email, recipient_email, cheer_id) VALUES ($1, $2, $3)",
      [senderEmail, targetEmail.toLowerCase(), cheerId]
    );

    const { rows: senderRows } = await pool.query("SELECT name FROM members WHERE email = $1", [senderEmail]);
    const senderName = senderRows[0]?.name || "Someone";

    sendNotificationToUser(targetEmail, {
      title: "WELL Tribe Cheer",
      body: `${senderName} sent you a cheer: ${cheerLabel}`,
      tag: "tribe-cheer",
      url: "/tribe",
    }).catch((err) => console.error("Failed to send WELL Tribe cheer notification:", err));

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Send WELL Tribe cheer error:", err);
    res.status(500).json({ error: "Failed to send cheer" });
  }
});

// Send an occasion card (birthday / thinking of you / hi / etc.) to a tribe member.
router.post("/tribe/:memberId/card", async (req, res) => {
  const { email, occasionId, styleId, message } = req.body as {
    email?: string;
    occasionId?: string;
    styleId?: string;
    message?: string;
  };
  if (!email || !occasionId || !styleId) {
    return res.status(400).json({ error: "email, occasionId, and styleId required" });
  }
  try {
    const targetEmail = await findEmailByMemberId(req.params.memberId);
    if (!targetEmail) return res.status(404).json({ error: "Member not found" });

    const { rows } = await pool.query("SELECT name FROM members WHERE email = $1", [email.toLowerCase()]);
    const senderName = rows[0]?.name || "Someone";

    const occasionLabels: Record<string, string> = {
      birthday: "a Birthday Card",
      "thinking-of-you": "a Thinking of You card",
      "just-saying-hi": "a Hello card",
      condolences: "a Condolences card",
      "youve-got-this": "a You've Got This card",
      congratulations: "a Congratulations card",
    };
    const label = occasionLabels[occasionId] ?? "a card";

    await sendNotificationToUser(targetEmail, {
      title: `${senderName} sent you ${label}`,
      body: message || `Open the app to view your card from ${senderName}.`,
      tag: "tribe-card",
      url: "/tribe",
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Send tribe card error:", err);
    res.status(500).json({ error: "Failed to send card" });
  }
});

// Invite a tribe member to a challenge.
router.post("/tribe/:memberId/challenge-invite", async (req, res) => {
  const { email, challengeId, challengeTitle } = req.body as {
    email?: string;
    challengeId?: string;
    challengeTitle?: string;
  };
  if (!email || !challengeId || !challengeTitle) {
    return res.status(400).json({ error: "email, challengeId, and challengeTitle required" });
  }
  try {
    const targetEmail = await findEmailByMemberId(req.params.memberId);
    if (!targetEmail) return res.status(404).json({ error: "Member not found" });

    const { rows } = await pool.query("SELECT name FROM members WHERE email = $1", [email.toLowerCase()]);
    const senderName = rows[0]?.name || "Someone";

    await sendNotificationToUser(targetEmail, {
      title: `${senderName} invited you to a challenge!`,
      body: `Join the ${challengeTitle} — let's do this together!`,
      tag: "tribe-challenge",
      url: "/tribe",
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Send challenge invite error:", err);
    res.status(500).json({ error: "Failed to send challenge invite" });
  }
});

// Invite a tribe member to an upcoming event.
router.post("/tribe/:memberId/event-invite", async (req, res) => {
  const { email, eventTitle, eventDate } = req.body as {
    email?: string;
    eventTitle?: string;
    eventDate?: string;
  };
  if (!email || !eventTitle) {
    return res.status(400).json({ error: "email and eventTitle required" });
  }
  try {
    const targetEmail = await findEmailByMemberId(req.params.memberId);
    if (!targetEmail) return res.status(404).json({ error: "Member not found" });

    const { rows } = await pool.query("SELECT name FROM members WHERE email = $1", [email.toLowerCase()]);
    const senderName = rows[0]?.name || "Someone";

    const dateStr = eventDate ? ` on ${new Date(eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
    await sendNotificationToUser(targetEmail, {
      title: `${senderName} wants you at an event!`,
      body: `Join ${senderName} for ${eventTitle}${dateStr}.`,
      tag: "tribe-event",
      url: "/events",
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Send event invite error:", err);
    res.status(500).json({ error: "Failed to send event invite" });
  }
});

// Set the caller's mood status (expires after 24 hours; null clears it)
router.post("/member/mood-status", async (req, res) => {
  const { email, moodStatusId } = req.body as { email?: string; moodStatusId?: string | null };
  if (!email) return res.status(400).json({ error: "email required" });

  const VALID_IDS = ["need-encouragement", "tough-day", "feeling-good", "celebrating", "crushing-it"];
  if (moodStatusId !== null && moodStatusId !== undefined && !VALID_IDS.includes(moodStatusId)) {
    return res.status(400).json({ error: "invalid moodStatusId" });
  }

  try {
    if (!moodStatusId) {
      await pool.query(
        "UPDATE members SET mood_status = NULL, mood_status_expires_at = NULL WHERE email = $1",
        [email.toLowerCase()]
      );
    } else {
      await pool.query(
        "UPDATE members SET mood_status = $1, mood_status_expires_at = NOW() + INTERVAL '24 hours' WHERE email = $2",
        [moodStatusId, email.toLowerCase()]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Set mood status error:", err);
    res.status(500).json({ error: "Failed to set mood status" });
  }
});

export default router;
