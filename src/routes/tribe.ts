import { Router } from "express";
import { pool } from "../db";
import { sendNotificationToUser } from "../push";
import { computeBonusBadges, computeLevelBadge } from "../badges";
import { awardPoints } from "./points";

const router = Router();

// Mirrors TRIBE_CHEERS in the client's src/data/cheers.ts — kept as a server
// whitelist so the notification text can't be spoofed by an arbitrary
// client-supplied string.
const TRIBE_CHEER_LABELS: Record<string, string> = {
  "crushing-it": "🔥 Crushing It!",
  "proud-of-you": "🎉 Proud of You!",
  "keep-going": "💪 Keep Going!",
};

// Mirrors deriveMemberId() in members.ts/messages.ts/AppContext.tsx — tribe
// members are referenced by id on the client, never raw email.
function deriveMemberId(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return `m_${Math.abs(hash).toString(36)}`;
}

async function findEmailByMemberId(memberId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT email FROM members");
  for (const row of rows) {
    if (deriveMemberId(row.email) === memberId) return row.email;
  }
  return null;
}

// Get a member's WELL Tribe
router.get("/tribe", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT m.email, m.name, m.avatar, m.workout_log, m.featured_badge, m.created_at,
              CASE WHEN m.show_birthday_on_calendar THEN m.birthday ELSE NULL END AS birthday
       FROM tribe_members t
       JOIN members m ON m.email = t.member_email
       WHERE t.owner_email = $1
       ORDER BY t.created_at DESC`,
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

export default router;
