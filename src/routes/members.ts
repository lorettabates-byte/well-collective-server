import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { computeBonusBadges, computeLevelBadge, SPECIAL_BADGE_IDS } from "../badges";
import { ADMIN_NOTIFY_EMAIL, sendNotificationToUser } from "../push";

const router = Router();

// Mirrors the client-side deriveMemberId() in AppContext.tsx exactly — both
// must produce the same id for a given email for DMs/likes/RSVPs to line up.
function deriveMemberId(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return `m_${Math.abs(hash).toString(36)}`;
}

// Member ids in URLs (DMs, forum authorship, etc.) are always the derived
// hash, never a raw email, so any route taking a memberId has to reverse it
// back to an email by scanning the directory -- mirrors findEmailByMemberId
// in messages.ts.
async function findEmailByMemberId(memberId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT email FROM members");
  for (const row of rows) {
    if (deriveMemberId(row.email) === memberId) return row.email;
  }
  return null;
}

router.post("/members/sync", async (req, res) => {
  const { email, name, avatar, bio, birthday, showBirthdayOnCalendar, workoutLog, savedInspirationIds, likedInspirationIds } = req.body as {
    email?: string;
    name?: string;
    avatar?: string;
    bio?: string;
    birthday?: string;
    showBirthdayOnCalendar?: boolean;
    workoutLog?: string[];
    savedInspirationIds?: string[];
    likedInspirationIds?: string[];
  };

  if (!email || !name) {
    return res.status(400).json({ error: "email and name required" });
  }

  const normalizedEmail = email.toLowerCase();

  try {
    const { rows: existingRows } = await pool.query("SELECT 1 FROM members WHERE email = $1", [normalizedEmail]);
    const isFirstTimeJoin = existingRows.length === 0;

    // Use COALESCE so a blank/missing avatar, bio, birthday, or workout log
    // from the client (e.g. a false-positive "new member" reset on the
    // client, or a stale/wiped local profile) can never overwrite a value
    // already saved for this member — it can only fill in a field that's
    // still empty. However, saved/liked inspiration IDs should always be updated
    // from the client since they reflect current user interactions.
    await pool.query(
      `INSERT INTO members (email, name, avatar, bio, birthday, show_birthday_on_calendar, workout_log, saved_inspiration_ids, liked_inspiration_ids, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (email) DO UPDATE SET
         name = $2,
         avatar = COALESCE($3, members.avatar),
         bio = COALESCE($4, members.bio),
         birthday = COALESCE($5, members.birthday),
         show_birthday_on_calendar = $6,
         workout_log = COALESCE($7, members.workout_log),
         saved_inspiration_ids = $8,
         liked_inspiration_ids = $9,
         updated_at = now()`,
      [
        normalizedEmail,
        name,
        avatar || null,
        bio || null,
        birthday || null,
        !!showBirthdayOnCalendar,
        workoutLog && workoutLog.length > 0 ? workoutLog : null,
        savedInspirationIds && savedInspirationIds.length > 0 ? savedInspirationIds : null,
        likedInspirationIds && likedInspirationIds.length > 0 ? likedInspirationIds : null,
      ]
    );

    if (isFirstTimeJoin && normalizedEmail !== ADMIN_NOTIFY_EMAIL) {
      sendNotificationToUser(ADMIN_NOTIFY_EMAIL, {
        title: "New WELL Collective signup",
        body: `${name} (${normalizedEmail}) just joined as a paid member.`,
        tag: "new-signup",
        url: "/admin",
      }).catch((err) => console.error("Admin signup notification failed:", err));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Sync member error:", err);
    res.status(500).json({ error: "Failed to sync member" });
  }
});

// Per-category push preferences are synced separately (not via /members/sync)
// so a toggle change takes effect immediately, without waiting for the next
// full profile sync — and so broadcastNotification/sendNotificationToUser in
// push.ts can actually filter sends by what each member has opted into.
router.put("/members/notification-settings", async (req, res) => {
  const { email, notificationSettings } = req.body as {
    email?: string;
    notificationSettings?: Record<string, boolean>;
  };

  if (!email || !notificationSettings) {
    return res.status(400).json({ error: "email and notificationSettings required" });
  }

  const normalizedEmail = email.toLowerCase();

  try {
    await pool.query(
      `INSERT INTO members (email, name, notification_settings, updated_at)
       VALUES ($1, $1, $2, now())
       ON CONFLICT (email) DO UPDATE SET notification_settings = $2, updated_at = now()`,
      [normalizedEmail, JSON.stringify(notificationSettings)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Update notification settings error:", err);
    res.status(500).json({ error: "Failed to update notification settings" });
  }
});

// Restore a member's own saved profile from the server. Used by the client
// to recover avatar/bio/birthday after local storage gets wiped (e.g. by
// Safari's tracking-prevention purge, or a fresh re-login) — without this,
// a wipe would permanently strand the member with a blank profile since
// the client only ever pushes local data to the server, never pulls it back.
router.get("/members/me", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();

  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT name, avatar, bio, birthday, show_birthday_on_calendar, workout_log, featured_badge, created_at, saved_inspiration_ids, liked_inspiration_ids
       FROM members WHERE email = $1`,
      [email]
    );

    if (rows.length === 0) {
      return res.json({ member: null });
    }

    const row = rows[0];
    const { rows: msgRows } = await pool.query(
      "SELECT COUNT(*) FROM forum_messages WHERE author_id = $1",
      [deriveMemberId(email)]
    );
    const { rows: cheerRows } = await pool.query(
      "SELECT COUNT(*) FROM tribe_cheers WHERE sender_email = $1",
      [email]
    );
    const { rows: badgeRows } = await pool.query(
      "SELECT badge_id FROM member_badges WHERE member_email = $1",
      [email]
    );

    const messageCount = Number(msgRows[0].count);

    res.json({
      member: {
        name: row.name,
        avatar: row.avatar ?? undefined,
        bio: row.bio ?? undefined,
        birthday: row.birthday ?? undefined,
        showBirthdayOnCalendar: row.show_birthday_on_calendar,
        levelBadge: computeLevelBadge(messageCount, (row.workout_log ?? []).length),
        bonusBadges: computeBonusBadges(row.created_at, messageCount, Number(cheerRows[0].count)),
        grantedBadges: badgeRows.map((b) => b.badge_id),
        featuredBadge: row.featured_badge ?? undefined,
        savedInspirationIds: row.saved_inspiration_ids ?? undefined,
        likedInspirationIds: row.liked_inspiration_ids ?? undefined,
      },
    });
  } catch (err) {
    console.error("Fetch member error:", err);
    res.status(500).json({ error: "Failed to fetch member" });
  }
});

// Set or clear which single earned badge a member wants shown on their
// avatar. badgeId is validated against what they've actually earned so a
// client can't feature a badge it hasn't unlocked.
router.post("/members/featured-badge", async (req, res) => {
  const { email, badgeId } = req.body as { email?: string; badgeId?: string | null };
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  const normalizedEmail = email.toLowerCase();

  try {
    if (badgeId) {
      const { rows } = await pool.query(
        "SELECT workout_log, created_at FROM members WHERE email = $1",
        [normalizedEmail]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "Member not found" });
      }
      const { rows: msgRows } = await pool.query(
        "SELECT COUNT(*) FROM forum_messages WHERE author_id = $1",
        [deriveMemberId(normalizedEmail)]
      );
      const { rows: cheerRows } = await pool.query(
        "SELECT COUNT(*) FROM tribe_cheers WHERE sender_email = $1",
        [normalizedEmail]
      );
      const messageCount = Number(msgRows[0].count);
      const levelBadge = computeLevelBadge(messageCount, (rows[0].workout_log ?? []).length);
      const bonusBadges = computeBonusBadges(rows[0].created_at, messageCount, Number(cheerRows[0].count));
      const { rows: badgeRows } = await pool.query(
        "SELECT badge_id FROM member_badges WHERE member_email = $1",
        [normalizedEmail]
      );
      const earned = new Set([levelBadge, ...bonusBadges, ...badgeRows.map((b) => b.badge_id)]);
      if (!earned.has(badgeId)) {
        return res.status(400).json({ error: "You haven't earned that badge yet" });
      }
    }

    await pool.query("UPDATE members SET featured_badge = $1 WHERE email = $2", [
      badgeId || null,
      normalizedEmail,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Set featured badge error:", err);
    res.status(500).json({ error: "Failed to set featured badge" });
  }
});

// Admin: grant or revoke a special badge (e.g. "well-escape") that can't be
// earned automatically from in-app activity.
router.post("/admin/members/:email/badges", requireAdmin, async (req, res) => {
  const { badgeId, grant } = req.body as { badgeId?: string; grant?: boolean };
  if (!badgeId || !SPECIAL_BADGE_IDS.includes(badgeId)) {
    return res.status(400).json({ error: "Invalid badgeId" });
  }

  const memberEmail = req.params.email.toLowerCase();

  try {
    if (grant) {
      await pool.query(
        "INSERT INTO member_badges (member_email, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [memberEmail, badgeId]
      );
    } else {
      await pool.query("DELETE FROM member_badges WHERE member_email = $1 AND badge_id = $2", [
        memberEmail,
        badgeId,
      ]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Grant badge error:", err);
    res.status(500).json({ error: "Failed to update badge" });
  }
});

// Admin: full member directory (email included, unlike the public /members
// list) so the admin panel can show who's a trial vs. who's a full member
// and delete or add entries.
router.get("/admin/members", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT email, name, avatar, trial_started_at, trial_ends_at, updated_at FROM members ORDER BY updated_at DESC"
    );
    const { rows: badgeRows } = await pool.query("SELECT member_email, badge_id FROM member_badges");
    const badgesByEmail = new Map<string, string[]>();
    for (const b of badgeRows) {
      badgesByEmail.set(b.member_email, [...(badgesByEmail.get(b.member_email) ?? []), b.badge_id]);
    }
    res.json({
      members: rows.map((row) => ({
        email: row.email,
        name: row.name,
        avatar: row.avatar ?? undefined,
        // pg parses DATE columns into JS Date objects, which JSON.stringify
        // serializes as full ISO timestamps ("2026-07-15T00:00:00.000Z") —
        // the client's formatDateLong expects a plain "YYYY-MM-DD" string
        // and silently produces "Invalid Date" on anything else.
        trialStartedAt: row.trial_started_at ? row.trial_started_at.toISOString().slice(0, 10) : undefined,
        trialEndsAt: row.trial_ends_at ? row.trial_ends_at.toISOString().slice(0, 10) : undefined,
        updatedAt: row.updated_at,
        grantedBadges: badgesByEmail.get(row.email) ?? [],
      })),
    });
  } catch (err) {
    console.error("Fetch admin members error:", err);
    res.status(500).json({ error: "Failed to fetch members" });
  }
});

// Admin: manually add a member — either a full member (no trial dates) or a
// trial grant (sets trial_started_at/trial_ends_at so they get trial access
// immediately, same as a member who signed up for it themselves).
router.post("/admin/members", requireAdmin, async (req, res) => {
  const { email, name, grantTrial } = req.body as { email?: string; name?: string; grantTrial?: boolean };
  if (!email?.trim() || !name?.trim()) {
    return res.status(400).json({ error: "Name and email are required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  let trialEndsAt: string | null = null;
  if (grantTrial) {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 7);
    trialEndsAt = trialEnd.toISOString().slice(0, 10);
  }

  try {
    await pool.query(
      `INSERT INTO members (email, name, trial_started_at, trial_ends_at)
       VALUES ($1, $2, ${grantTrial ? "now()" : "NULL"}, $3)
       ON CONFLICT (email) DO UPDATE SET name = $2`,
      [normalizedEmail, name.trim(), trialEndsAt]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Add member error:", err);
    res.status(500).json({ error: "Failed to add member" });
  }
});

// Includes badge fields so any page rendering another member's avatar
// (DMs, the new-message picker, forum posts/messages via deriveMemberId)
// can show their badge, not just the WELL Tribe pages.
router.get("/members", async (req, res) => {
  const excludeEmail = (req.query.excludeEmail as string | undefined)?.toLowerCase();

  try {
    const { rows } = await pool.query(
      "SELECT email, name, avatar, workout_log, featured_badge, created_at FROM members WHERE email != $1 ORDER BY name ASC",
      [excludeEmail || ""]
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
      members: rows.map((row) => {
        const id = deriveMemberId(row.email);
        const messageCount = msgCountByAuthorId.get(id) ?? 0;
        return {
          id,
          name: row.name,
          avatar: row.avatar ?? undefined,
          levelBadge: computeLevelBadge(messageCount, (row.workout_log ?? []).length),
          bonusBadges: computeBonusBadges(row.created_at, messageCount, cheerCountByEmail.get(row.email) ?? 0),
          grantedBadges: badgesByEmail.get(row.email) ?? [],
          featuredBadge: row.featured_badge ?? undefined,
        };
      }),
    });
  } catch (err) {
    console.error("Fetch members error:", err);
    res.status(500).json({ error: "Failed to fetch members" });
  }
});

// Public profile for any single member, looked up by their derived id (the
// same id used for DM/forum authorship) rather than email, since that's all
// the client has when someone taps another member's avatar. Birthday is only
// included if they've opted in to showing it on the calendar -- same rule
// the calendar sync already enforces.
router.get("/members/:memberId/profile", async (req, res) => {
  const { memberId } = req.params;

  try {
    const email = await findEmailByMemberId(memberId);
    if (!email) {
      return res.status(404).json({ error: "Member not found" });
    }

    const { rows } = await pool.query(
      `SELECT name, avatar, bio, birthday, show_birthday_on_calendar, workout_log, featured_badge, created_at
       FROM members WHERE email = $1`,
      [email]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }
    const row = rows[0];

    const { rows: msgRows } = await pool.query(
      "SELECT COUNT(*) FROM forum_messages WHERE author_id = $1",
      [memberId]
    );
    const { rows: cheerRows } = await pool.query(
      "SELECT COUNT(*) FROM tribe_cheers WHERE sender_email = $1",
      [email]
    );
    const { rows: badgeRows } = await pool.query(
      "SELECT badge_id FROM member_badges WHERE member_email = $1",
      [email]
    );
    const { rows: tribeCountRows } = await pool.query(
      "SELECT COUNT(*) FROM tribe_members WHERE owner_email = $1",
      [email]
    );

    const messageCount = Number(msgRows[0].count);
    const workoutLog: string[] = row.workout_log ?? [];

    res.json({
      member: {
        id: memberId,
        name: row.name,
        avatar: row.avatar ?? undefined,
        bio: row.bio ?? undefined,
        birthday: row.show_birthday_on_calendar ? row.birthday ?? undefined : undefined,
        workoutLog,
        levelBadge: computeLevelBadge(messageCount, workoutLog.length),
        bonusBadges: computeBonusBadges(row.created_at, messageCount, Number(cheerRows[0].count)),
        grantedBadges: badgeRows.map((b) => b.badge_id),
        featuredBadge: row.featured_badge ?? undefined,
        tribeConnections: Number(tribeCountRows[0].count),
      },
    });
  } catch (err) {
    console.error("Fetch member profile error:", err);
    res.status(500).json({ error: "Failed to fetch member profile" });
  }
});

router.get("/members/birthdays", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT email, name, birthday FROM members WHERE show_birthday_on_calendar = true AND birthday IS NOT NULL"
    );
    res.json({
      birthdays: rows.map((row) => ({
        id: deriveMemberId(row.email),
        name: row.name,
        birthday: row.birthday,
      })),
    });
  } catch (err) {
    console.error("Fetch birthdays error:", err);
    res.status(500).json({ error: "Failed to fetch birthdays" });
  }
});

// Remove a member from the shared directory (e.g. a stale test account) —
// there was previously no way to do this at all.
router.delete("/members/:email", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM members WHERE email = $1", [req.params.email.toLowerCase()]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete member error:", err);
    res.status(500).json({ error: "Failed to delete member" });
  }
});

export default router;
