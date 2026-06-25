import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { computeLevelBadge, SPECIAL_BADGE_IDS } from "../badges";

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

router.post("/members/sync", async (req, res) => {
  const { email, name, avatar, bio, birthday, showBirthdayOnCalendar, workoutLog } = req.body as {
    email?: string;
    name?: string;
    avatar?: string;
    bio?: string;
    birthday?: string;
    showBirthdayOnCalendar?: boolean;
    workoutLog?: string[];
  };

  if (!email || !name) {
    return res.status(400).json({ error: "email and name required" });
  }

  try {
    // Use COALESCE so a blank/missing avatar, bio, birthday, or workout log
    // from the client (e.g. a false-positive "new member" reset on the
    // client, or a stale/wiped local profile) can never overwrite a value
    // already saved for this member — it can only fill in a field that's
    // still empty.
    await pool.query(
      `INSERT INTO members (email, name, avatar, bio, birthday, show_birthday_on_calendar, workout_log, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (email) DO UPDATE SET
         name = $2,
         avatar = COALESCE($3, members.avatar),
         bio = COALESCE($4, members.bio),
         birthday = COALESCE($5, members.birthday),
         show_birthday_on_calendar = $6,
         workout_log = COALESCE($7, members.workout_log),
         updated_at = now()`,
      [
        email.toLowerCase(),
        name,
        avatar || null,
        bio || null,
        birthday || null,
        !!showBirthdayOnCalendar,
        workoutLog && workoutLog.length > 0 ? workoutLog : null,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Sync member error:", err);
    res.status(500).json({ error: "Failed to sync member" });
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
      `SELECT name, avatar, bio, birthday, show_birthday_on_calendar, workout_log, featured_badge
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
    const { rows: badgeRows } = await pool.query(
      "SELECT badge_id FROM member_badges WHERE member_email = $1",
      [email]
    );

    res.json({
      member: {
        name: row.name,
        avatar: row.avatar ?? undefined,
        bio: row.bio ?? undefined,
        birthday: row.birthday ?? undefined,
        showBirthdayOnCalendar: row.show_birthday_on_calendar,
        levelBadge: computeLevelBadge(Number(msgRows[0].count), (row.workout_log ?? []).length),
        grantedBadges: badgeRows.map((b) => b.badge_id),
        featuredBadge: row.featured_badge ?? undefined,
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
        "SELECT workout_log FROM members WHERE email = $1",
        [normalizedEmail]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "Member not found" });
      }
      const { rows: msgRows } = await pool.query(
        "SELECT COUNT(*) FROM forum_messages WHERE author_id = $1",
        [deriveMemberId(normalizedEmail)]
      );
      const levelBadge = computeLevelBadge(Number(msgRows[0].count), (rows[0].workout_log ?? []).length);
      const { rows: badgeRows } = await pool.query(
        "SELECT badge_id FROM member_badges WHERE member_email = $1",
        [normalizedEmail]
      );
      const earned = new Set([levelBadge, ...badgeRows.map((b) => b.badge_id)]);
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
        trialStartedAt: row.trial_started_at ?? undefined,
        trialEndsAt: row.trial_ends_at ?? undefined,
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

router.get("/members", async (req, res) => {
  const excludeEmail = (req.query.excludeEmail as string | undefined)?.toLowerCase();

  try {
    const { rows } = await pool.query(
      "SELECT email, name, avatar FROM members WHERE email != $1 ORDER BY name ASC",
      [excludeEmail || ""]
    );
    res.json({
      members: rows.map((row) => ({
        id: deriveMemberId(row.email),
        name: row.name,
        avatar: row.avatar ?? undefined,
      })),
    });
  } catch (err) {
    console.error("Fetch members error:", err);
    res.status(500).json({ error: "Failed to fetch members" });
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
