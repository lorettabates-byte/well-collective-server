import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { sendNotificationToUser } from "../push";
import { computeBonusBadges, computeLevelBadge } from "../badges";
import { awardPoints } from "./points";
import { deriveMemberId, findEmailByMemberId } from "../utils/memberUtils";
import { createMemberNotification } from "../memberNotifications";

const router = Router();

// Mirrors TRIBE_CHEERS in the client's src/data/cheers.ts — kept as a server
// whitelist so the notification text can't be spoofed by an arbitrary
// client-supplied string.
const TRIBE_CHEER_LABELS: Record<string, string> = {
  "welcome": "Welcome to WELL Collective! So glad you're here!",
  "crushing-it": "Crushing It!",
  "proud-of-you": "Proud of You!",
  "keep-going": "Keep Going!",
  "you-inspire-me": "You Inspire Me!",
  "thinking-of-you": "Thinking of You!",
  "youre-amazing": "You're Amazing!",
  "way-to-go": "Way to Go!",
  "happy-birthday": "Happy Birthday! Wishing you a wonderful day!",
};

interface ChallengeGoal {
  id: string;
  label: string;
}

interface ChallengeDefinition {
  id: string;
  title: string;
  description: string;
  duration: string;
  category: "nutrition" | "fitness" | "mindfulness" | "wellness";
  goals: ChallengeGoal[];
}

const TRIBE_CHALLENGE_DEFS: Record<string, ChallengeDefinition> = {
  "nourishment-3day": {
    id: "nourishment-3day",
    title: "3-Day Nourishment Challenge",
    description: "Log your meals together for 3 days straight.",
    duration: "3 days",
    category: "nutrition",
    goals: [
      { id: "day-1", label: "Day 1 meals logged" },
      { id: "day-2", label: "Day 2 meals logged" },
      { id: "day-3", label: "Day 3 meals logged" },
    ],
  },
  "workout-streak-7": {
    id: "workout-streak-7",
    title: "7-Day Streak Challenge",
    description: "Complete a movement session every day for a week.",
    duration: "7 days",
    category: "fitness",
    goals: Array.from({ length: 7 }, (_, i) => ({ id: `day-${i + 1}`, label: `Day ${i + 1} workout complete` })),
  },
  "morning-ritual-5": {
    id: "morning-ritual-5",
    title: "Morning Ritual Challenge",
    description: "Complete your WELL Check before noon for 5 days.",
    duration: "5 days",
    category: "wellness",
    goals: Array.from({ length: 5 }, (_, i) => ({ id: `day-${i + 1}`, label: `Day ${i + 1} WELL Check before noon` })),
  },
  "mindfulness-5": {
    id: "mindfulness-5",
    title: "Mindfulness Challenge",
    description: "Complete a breathwork session every day for 5 days.",
    duration: "5 days",
    category: "mindfulness",
    goals: Array.from({ length: 5 }, (_, i) => ({ id: `day-${i + 1}`, label: `Day ${i + 1} breathwork complete` })),
  },
  "wellcheck-7": {
    id: "wellcheck-7",
    title: "Full WELL Check Challenge",
    description: "Complete all WELL Check areas for 7 days in a row.",
    duration: "7 days",
    category: "wellness",
    goals: Array.from({ length: 7 }, (_, i) => ({ id: `day-${i + 1}`, label: `Day ${i + 1} full WELL Check` })),
  },
  "hydration-5": {
    id: "hydration-5",
    title: "Hydration Reset",
    description: "Hit your water goal together for 5 days.",
    duration: "5 days",
    category: "nutrition",
    goals: Array.from({ length: 5 }, (_, i) => ({ id: `day-${i + 1}`, label: `Day ${i + 1} water goal met` })),
  },
};

function progressArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function iso(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function challengeResponse(row: Record<string, any>, viewerEmail: string) {
  const viewer = viewerEmail.toLowerCase();
  const isSender = row.sender_email === viewer;
  const myProgress = progressArray(isSender ? row.sender_progress : row.recipient_progress);
  const partnerProgress = progressArray(isSender ? row.recipient_progress : row.sender_progress);
  return {
    id: Number(row.id),
    challengeId: row.challenge_key,
    title: row.title,
    description: row.description,
    duration: row.duration_label,
    category: row.category,
    goals: row.goals ?? [],
    bonusPoints: Number(row.bonus_points ?? 25),
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
    myProgress,
    partnerProgress,
    myCompletedAt: iso(isSender ? row.sender_completed_at : row.recipient_completed_at),
    partnerCompletedAt: iso(isSender ? row.recipient_completed_at : row.sender_completed_at),
    partner: {
      name: isSender ? row.recipient_name : row.sender_name,
      avatar: isSender ? row.recipient_avatar : row.sender_avatar,
    },
    invitedByMe: isSender,
  };
}

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
         AND (m.email IS NULL
              OR m.trial_ends_at IS NULL
              OR m.trial_ends_at >= CURRENT_DATE
              OR m.membership_status = 'active')
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

    const { rows: cardRows } = await pool.query(
      `INSERT INTO tribe_cards (sender_email, recipient_email, occasion_id, style_id, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [email.toLowerCase(), targetEmail.toLowerCase(), occasionId, styleId, message || ""]
    );
    const cardId = Number(cardRows[0].id);
    const link = `/tribe?card=${cardId}`;
    const title = `You received a card from ${senderName}`;

    await createMemberNotification({
      memberEmail: targetEmail,
      type: "tribe",
      title,
      body: "Tap to open your card.",
      link,
      metadata: { cardId },
    });

    await sendNotificationToUser(targetEmail, {
      title,
      body: "Open your card in WELL Collective.",
      tag: "tribe-card",
      url: link,
    });

    res.status(201).json({ ok: true, cardId });
  } catch (err) {
    console.error("Send tribe card error:", err);
    res.status(500).json({ error: "Failed to send card" });
  }
});

// Open a received card. Only the sender or recipient can fetch the card body.
router.get("/tribe/cards/:cardId", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.occasion_id, c.style_id, c.message, c.created_at,
              sm.name AS sender_name, rm.name AS recipient_name,
              c.sender_email, c.recipient_email
       FROM tribe_cards c
       JOIN members sm ON sm.email = c.sender_email
       JOIN members rm ON rm.email = c.recipient_email
       WHERE c.id = $1
         AND (c.sender_email = $2 OR c.recipient_email = $2)`,
      [req.params.cardId, email]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Card not found" });

    await pool.query(
      `UPDATE tribe_cards
       SET opened_at = COALESCE(opened_at, now())
       WHERE id = $1 AND recipient_email = $2`,
      [req.params.cardId, email]
    );

    const row = rows[0];
    res.json({
      card: {
        id: Number(row.id),
        occasionId: row.occasion_id,
        styleId: row.style_id,
        message: row.message,
        senderName: row.sender_name,
        recipientName: row.recipient_name,
        createdAt: iso(row.created_at),
      },
    });
  } catch (err) {
    console.error("Fetch tribe card error:", err);
    res.status(500).json({ error: "Failed to fetch card" });
  }
});

// Invite a tribe member to a challenge.
router.post("/tribe/:memberId/challenge-invite", async (req, res) => {
  const { email, challengeId } = req.body as {
    email?: string;
    challengeId?: string;
  };
  const def = challengeId ? TRIBE_CHALLENGE_DEFS[challengeId] : undefined;
  if (!email || !def) {
    return res.status(400).json({ error: "email and a valid challengeId required" });
  }
  try {
    const targetEmail = await findEmailByMemberId(req.params.memberId);
    if (!targetEmail) return res.status(404).json({ error: "Member not found" });

    const { rows } = await pool.query("SELECT name FROM members WHERE email = $1", [email.toLowerCase()]);
    const senderName = rows[0]?.name || "Someone";

    const { rows: challengeRows } = await pool.query(
      `INSERT INTO tribe_challenges (
         challenge_key, title, description, duration_label, category, goals,
         bonus_points, sender_email, recipient_email
       )
       VALUES ($1, $2, $3, $4, $5, $6, 25, $7, $8)
       RETURNING id`,
      [
        def.id,
        def.title,
        def.description,
        def.duration,
        def.category,
        JSON.stringify(def.goals),
        email.toLowerCase(),
        targetEmail.toLowerCase(),
      ]
    );
    const challengeRecordId = Number(challengeRows[0].id);
    const link = `/tribe?challenge=${challengeRecordId}`;

    await createMemberNotification({
      memberEmail: targetEmail,
      type: "tribe",
      title: `${senderName} invited you to a challenge`,
      body: `${def.title} is ready on your WELL Tribe page.`,
      link,
      metadata: { challengeId: challengeRecordId, challengeKey: def.id },
    });

    await sendNotificationToUser(targetEmail, {
      title: `${senderName} invited you to a challenge!`,
      body: `Join ${def.title} together in WELL Tribe.`,
      tag: "tribe-challenge",
      url: link,
    });

    res.status(201).json({ ok: true, challengeId: challengeRecordId });
  } catch (err) {
    console.error("Send challenge invite error:", err);
    res.status(500).json({ error: "Failed to send challenge invite" });
  }
});

router.get("/tribe/challenges", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(
      `SELECT tc.*,
              sm.name AS sender_name, sm.avatar AS sender_avatar,
              rm.name AS recipient_name, rm.avatar AS recipient_avatar
       FROM tribe_challenges tc
       JOIN members sm ON sm.email = tc.sender_email
       JOIN members rm ON rm.email = tc.recipient_email
       WHERE tc.sender_email = $1 OR tc.recipient_email = $1
       ORDER BY tc.completed_at NULLS FIRST, tc.created_at DESC
       LIMIT 50`,
      [email]
    );

    res.json({ challenges: rows.map((row) => challengeResponse(row, email)) });
  } catch (err) {
    console.error("Fetch tribe challenges error:", err);
    res.status(500).json({ error: "Failed to fetch tribe challenges" });
  }
});

router.patch("/tribe/challenges/:challengeId/progress", async (req, res) => {
  const { email, goalId, completed } = req.body as {
    email?: string;
    goalId?: string;
    completed?: boolean;
  };
  if (!email || !goalId || typeof completed !== "boolean") {
    return res.status(400).json({ error: "email, goalId, and completed required" });
  }

  const memberEmail = email.toLowerCase();

  try {
    const { rows } = await pool.query(
      `SELECT tc.*,
              sm.name AS sender_name, sm.avatar AS sender_avatar,
              rm.name AS recipient_name, rm.avatar AS recipient_avatar
       FROM tribe_challenges tc
       JOIN members sm ON sm.email = tc.sender_email
       JOIN members rm ON rm.email = tc.recipient_email
       WHERE tc.id = $1
         AND (tc.sender_email = $2 OR tc.recipient_email = $2)`,
      [req.params.challengeId, memberEmail]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Challenge not found" });

    const row = rows[0];
    if (row.completed_at) {
      return res.json({ challenge: challengeResponse(row, memberEmail), awarded: false, points: 0 });
    }

    const goals = (row.goals ?? []) as ChallengeGoal[];
    if (!goals.some((goal) => goal.id === goalId)) {
      return res.status(400).json({ error: "Unknown goal" });
    }

    const isSender = row.sender_email === memberEmail;
    const progressColumn = isSender ? "sender_progress" : "recipient_progress";
    const completedColumn = isSender ? "sender_completed_at" : "recipient_completed_at";
    const current = new Set(progressArray(isSender ? row.sender_progress : row.recipient_progress));
    if (completed) current.add(goalId);
    else current.delete(goalId);
    const nextProgress = Array.from(current);
    const memberComplete = goals.every((goal) => current.has(goal.id));

    await pool.query(
      `UPDATE tribe_challenges
       SET ${progressColumn} = $1::jsonb,
           ${completedColumn} = CASE WHEN $2 THEN COALESCE(${completedColumn}, now()) ELSE NULL END
       WHERE id = $3`,
      [JSON.stringify(nextProgress), memberComplete, row.id]
    );

    const { rows: updatedRows } = await pool.query(
      `SELECT tc.*,
              sm.name AS sender_name, sm.avatar AS sender_avatar,
              rm.name AS recipient_name, rm.avatar AS recipient_avatar
       FROM tribe_challenges tc
       JOIN members sm ON sm.email = tc.sender_email
       JOIN members rm ON rm.email = tc.recipient_email
       WHERE tc.id = $1`,
      [row.id]
    );

    const updated = updatedRows[0];
    const senderDone = goals.every((goal) => progressArray(updated.sender_progress).includes(goal.id));
    const recipientDone = goals.every((goal) => progressArray(updated.recipient_progress).includes(goal.id));
    let awarded = false;

    if (senderDone && recipientDone && !updated.completed_at) {
      await pool.query("UPDATE tribe_challenges SET completed_at = now() WHERE id = $1", [row.id]);
      await Promise.all([
        awardPoints(updated.sender_email, "tribe_challenge_complete", { challengeId: row.id, challengeKey: updated.challenge_key }),
        awardPoints(updated.recipient_email, "tribe_challenge_complete", { challengeId: row.id, challengeKey: updated.challenge_key }),
      ]);
      awarded = true;
    }

    const { rows: finalRows } = await pool.query(
      `SELECT tc.*,
              sm.name AS sender_name, sm.avatar AS sender_avatar,
              rm.name AS recipient_name, rm.avatar AS recipient_avatar
       FROM tribe_challenges tc
       JOIN members sm ON sm.email = tc.sender_email
       JOIN members rm ON rm.email = tc.recipient_email
       WHERE tc.id = $1`,
      [row.id]
    );

    res.json({
      challenge: challengeResponse(finalRows[0], memberEmail),
      awarded,
      points: awarded ? Number(finalRows[0].bonus_points ?? 25) : 0,
    });
  } catch (err) {
    console.error("Update tribe challenge progress error:", err);
    res.status(500).json({ error: "Failed to update challenge progress" });
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
