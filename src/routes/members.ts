import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { computeBonusBadges, computeLevelBadge, SPECIAL_BADGE_IDS } from "../badges";
import { ADMIN_NOTIFY_EMAIL, ADMIN_NOTIFY_EMAILS, sendNotificationToUser } from "../push";
import { addTrialContactToBrevo } from "../brevo";
import { sendDay3EmailBlast } from "../scheduler";
import { deriveMemberId, findEmailByMemberId } from "../utils/memberUtils";

const router = Router();

// Fire-and-forget — syncs a birthday (MM-DD) to WordPress user meta so UMP
// birthday emails trigger on the correct day. Never blocks the member response.
function syncBirthdayToWordPress(email: string, birthday: string): void {
  const videolibraryUrl = process.env.VIDEOLIBRARY_URL || "https://videolibrary.lorettabates.com";
  const apiKey = process.env.WELL_API_KEY || "";
  fetch(`${videolibraryUrl}/wp-json/well/v1/update-birthday`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WELL-API-KEY": apiKey },
    body: JSON.stringify({ email, birthday }),
    signal: AbortSignal.timeout(8000),
  })
    .then(async (r) => {
      if (!r.ok) console.error("WP birthday sync failed:", r.status, await r.text().catch(() => ""));
    })
    .catch((err) => console.error("WP birthday sync error:", err));
}

router.post("/members/sync", async (req, res) => {
  const { email, name, avatar, bio, birthday, showBirthdayOnCalendar, workoutLog, savedInspirationIds, likedInspirationIds, favoriteSongIds, heightCm, weightKg, age, gender, healthSyncEnabled, breathworkLog, wellActivityLog, resistanceLog, stretchingLog } = req.body as {
    email?: string;
    name?: string;
    avatar?: string;
    bio?: string;
    birthday?: string;
    showBirthdayOnCalendar?: boolean;
    workoutLog?: string[];
    savedInspirationIds?: string[];
    likedInspirationIds?: string[];
    favoriteSongIds?: number[];
    heightCm?: number;
    weightKg?: number;
    age?: number;
    gender?: string;
    healthSyncEnabled?: boolean;
    breathworkLog?: string[];
    wellActivityLog?: string[];
    resistanceLog?: string[];
    stretchingLog?: string[];
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
      `INSERT INTO members (email, name, avatar, bio, birthday, show_birthday_on_calendar, workout_log, saved_inspiration_ids, liked_inspiration_ids, favorite_song_ids, height_cm, weight_kg, age, gender, health_sync_enabled, breathwork_log, well_activity_log, resistance_log, stretching_log, goal_plan, notification_tone, movement_target, goals_completed, goals_refresh_period, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, now())
       ON CONFLICT (email) DO UPDATE SET
         name = $2,
         avatar = COALESCE($3, members.avatar),
         bio = COALESCE($4, members.bio),
         birthday = COALESCE($5, members.birthday),
         show_birthday_on_calendar = $6,
         workout_log = COALESCE($7, members.workout_log),
         saved_inspiration_ids = COALESCE($8, members.saved_inspiration_ids),
         liked_inspiration_ids = COALESCE($9, members.liked_inspiration_ids),
         favorite_song_ids = COALESCE($10, members.favorite_song_ids),
         height_cm = COALESCE($11, members.height_cm),
         weight_kg = COALESCE($12, members.weight_kg),
         age = COALESCE($13, members.age),
         gender = COALESCE($14, members.gender),
         health_sync_enabled = $15,
         breathwork_log = COALESCE($16, members.breathwork_log),
         well_activity_log = COALESCE($17, members.well_activity_log),
         resistance_log = COALESCE($18, members.resistance_log),
         stretching_log = COALESCE($19, members.stretching_log),
         goal_plan = COALESCE($20, members.goal_plan),
         notification_tone = COALESCE($21, members.notification_tone),
         movement_target = COALESCE($22, members.movement_target),
         goals_completed = CASE WHEN $23 THEN TRUE ELSE members.goals_completed END,
         goals_refresh_period = COALESCE($24, members.goals_refresh_period),
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
        favoriteSongIds && favoriteSongIds.length > 0 ? favoriteSongIds : null,
        heightCm ?? null,
        weightKg ?? null,
        age ?? null,
        gender || null,
        !!healthSyncEnabled,
        breathworkLog && breathworkLog.length > 0 ? breathworkLog : null,
        wellActivityLog && wellActivityLog.length > 0 ? wellActivityLog : null,
        resistanceLog && resistanceLog.length > 0 ? resistanceLog : null,
        stretchingLog && stretchingLog.length > 0 ? stretchingLog : null,
        (req.body as Record<string, unknown>).goalPlan || null,
        (req.body as Record<string, unknown>).notificationTone || null,
        (req.body as Record<string, unknown>).movementTarget || null,
        !!(req.body as Record<string, unknown>).goalsCompleted,
        (req.body as Record<string, unknown>).goalsRefreshPeriod || null,
      ]
    );

    if (isFirstTimeJoin && !ADMIN_NOTIFY_EMAILS.includes(normalizedEmail)) {
      for (const adminEmail of ADMIN_NOTIFY_EMAILS) {
        sendNotificationToUser(adminEmail, {
          title: "New WELL Collective signup",
          body: `${name} (${normalizedEmail}) just joined as a paid member.`,
          tag: "new-signup",
          url: "/admin",
        }).catch((err) => console.error("Admin signup notification failed:", err));
      }
    }

    if (birthday) {
      syncBirthdayToWordPress(normalizedEmail, birthday);
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
  const { email, notificationSettings, timezone, notificationSchedule, notifQuietStart, notifQuietEnd } = req.body as {
    email?: string;
    notificationSettings?: Record<string, boolean>;
    timezone?: string;
    notificationSchedule?: { send7am?: boolean; send3pm?: boolean; send9pm?: boolean };
    notifQuietStart?: string | null;
    notifQuietEnd?: string | null;
  };

  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  const normalizedEmail = email.toLowerCase();

  try {
    // Build update fields dynamically — only update provided fields
    let updateFields = ["updated_at = now()"];
    const params: any[] = [normalizedEmail];

    if (notificationSettings) {
      updateFields.push(`notification_settings = $${params.length + 1}`);
      params.push(JSON.stringify(notificationSettings));
    }

    if (timezone) {
      updateFields.push(`timezone = $${params.length + 1}`);
      params.push(timezone);
    }

    if (notificationSchedule) {
      updateFields.push(`notification_schedule = $${params.length + 1}`);
      params.push(JSON.stringify(notificationSchedule));
    }

    if (notifQuietStart !== undefined) {
      updateFields.push(`notif_quiet_start = $${params.length + 1}`);
      params.push(notifQuietStart);
    }

    if (notifQuietEnd !== undefined) {
      updateFields.push(`notif_quiet_end = $${params.length + 1}`);
      params.push(notifQuietEnd);
    }

    const updateClause = updateFields.join(", ");

    await pool.query(
      `INSERT INTO members (email, name, updated_at) VALUES ($1, $1, now())
       ON CONFLICT (email) DO UPDATE SET ${updateClause}`,
      params
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
      `SELECT name, avatar, bio, birthday, show_birthday_on_calendar, workout_log, featured_badge, created_at, saved_inspiration_ids, liked_inspiration_ids, favorite_song_ids, show_on_leaderboard, hidden_from_community, height_cm, weight_kg, age, gender, health_sync_enabled, breathwork_log, well_activity_log, resistance_log, stretching_log, goal_plan, notification_tone, movement_target, goals_completed, goals_refresh_period, last_monthly_win_at, last_monthly_win_pts, last_daily_win_at, last_daily_win_pts, last_yearly_win_at, last_yearly_win_pts, notif_quiet_start, notif_quiet_end, rating_prompt_pending, timezone, notification_schedule, notification_settings,
              CASE WHEN mood_status_expires_at > NOW() THEN mood_status ELSE NULL END AS mood_status
       FROM members WHERE email = $1`,
      [email]
    );

    if (rows.length === 0) {
      return res.json({ member: null });
    }

    const row = rows[0];
    const [msgRows, cheerRows, badgeRows, tribeAddedRows, tribeAddedByRows, totalPtsRows, tutorialRows] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM forum_messages WHERE author_id = $1", [deriveMemberId(email)]),
      pool.query("SELECT COUNT(*) FROM tribe_cheers WHERE sender_email = $1", [email]),
      pool.query("SELECT badge_id FROM member_badges WHERE member_email = $1", [email]),
      pool.query("SELECT COUNT(*) FROM tribe_members WHERE owner_email = $1", [email]),
      pool.query("SELECT COUNT(*) FROM tribe_members WHERE member_email = $1", [email]),
      pool.query("SELECT COALESCE(SUM(points), 0) AS total FROM activity_logs WHERE member_email = $1", [email]),
      pool.query("SELECT 1 FROM activity_logs WHERE member_email = $1 AND activity_type = 'tutorial_complete' LIMIT 1", [email]),
    ]);

    const messageCount = Number(msgRows.rows[0].count);

    res.json({
      member: {
        name: row.name,
        avatar: row.avatar ?? undefined,
        bio: row.bio ?? undefined,
        birthday: row.birthday ?? undefined,
        showBirthdayOnCalendar: row.show_birthday_on_calendar,
        workoutLog: row.workout_log ?? [],
        levelBadge: computeLevelBadge(messageCount, (row.workout_log ?? []).length),
        bonusBadges: computeBonusBadges(row.created_at, messageCount, Number(cheerRows.rows[0].count)),
        grantedBadges: badgeRows.rows.map((b) => b.badge_id),
        featuredBadge: row.featured_badge ?? undefined,
        savedInspirationIds: row.saved_inspiration_ids ?? undefined,
        likedInspirationIds: row.liked_inspiration_ids ?? undefined,
        favoriteSongIds: row.favorite_song_ids ?? undefined,
        showOnLeaderboard: row.show_on_leaderboard ?? true,
        hiddenFromCommunity: row.hidden_from_community ?? false,
        heightCm: row.height_cm != null ? Number(row.height_cm) : undefined,
        weightKg: row.weight_kg != null ? Number(row.weight_kg) : undefined,
        age: row.age != null ? Number(row.age) : undefined,
        gender: row.gender ?? undefined,
        healthSyncEnabled: row.health_sync_enabled ?? false,
        breathworkLog: row.breathwork_log ?? [],
        wellActivityLog: row.well_activity_log ?? [],
        resistanceLog: row.resistance_log ?? [],
        stretchingLog: row.stretching_log ?? [],
        goalPlan: row.goal_plan ?? undefined,
        notificationTone: row.notification_tone ?? undefined,
        movementTarget: row.movement_target ?? undefined,
        goalsCompleted: row.goals_completed ?? false,
        goalsRefreshPeriod: row.goals_refresh_period ?? undefined,
        moodStatus: row.mood_status ?? null,
        tribeConnections: Number(tribeAddedRows.rows[0].count),
        addedByCount: Number(tribeAddedByRows.rows[0].count),
        allTimePoints: Number(totalPtsRows.rows[0].total),
        lastMonthlyWinAt: row.last_monthly_win_at ? new Date(row.last_monthly_win_at).toISOString() : undefined,
        lastMonthlyWinPts: row.last_monthly_win_pts ? Number(row.last_monthly_win_pts) : undefined,
        lastDailyWinAt: row.last_daily_win_at ? new Date(row.last_daily_win_at).toISOString() : undefined,
        lastDailyWinPts: row.last_daily_win_pts ? Number(row.last_daily_win_pts) : undefined,
        lastYearlyWinAt: row.last_yearly_win_at ? new Date(row.last_yearly_win_at).toISOString() : undefined,
        lastYearlyWinPts: row.last_yearly_win_pts ? Number(row.last_yearly_win_pts) : undefined,
        notifQuietStart: row.notif_quiet_start ?? undefined,
        notifQuietEnd: row.notif_quiet_end ?? undefined,
        ratingPromptPending: row.rating_prompt_pending ?? false,
        tutorialCompleted: tutorialRows.rows.length > 0,
        timezone: row.timezone ?? undefined,
        notificationSchedule: row.notification_schedule ?? undefined,
        notificationSettings: row.notification_settings ?? undefined,
        hiddenFromCommunity: row.hidden_from_community ?? false,
        showOnLeaderboard: row.show_on_leaderboard ?? true,
        lastYearlyWinAt: row.last_yearly_win_at ? new Date(row.last_yearly_win_at).toISOString() : undefined,
        lastYearlyWinPts: row.last_yearly_win_pts ? Number(row.last_yearly_win_pts) : undefined,
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

// Self-service: any logged-in full member can claim the founding-member badge
// during the first 6 months after launch (before 2027-01-03). Idempotent.
router.post("/members/claim-founding-badge", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });

  const FOUNDING_CUTOFF = "2027-01-03";
  const today = new Date().toISOString().slice(0, 10);
  if (today > FOUNDING_CUTOFF) return res.json({ granted: false, reason: "offer_expired" });

  const memberEmail = email.toLowerCase();
  try {
    const { rows } = await pool.query(
      "SELECT trial_ends_at FROM members WHERE email = $1",
      [memberEmail]
    );
    if (rows.length === 0) return res.json({ granted: false, reason: "not_found" });

    const trialEndsAt: string | null = rows[0].trial_ends_at ? rows[0].trial_ends_at.toISOString().slice(0, 10) : null;
    const onActiveTrial = !!trialEndsAt && trialEndsAt > today;
    if (onActiveTrial) return res.json({ granted: false, reason: "on_trial" });

    await pool.query(
      "INSERT INTO member_badges (member_email, badge_id) VALUES ($1, 'founding-member') ON CONFLICT DO NOTHING",
      [memberEmail]
    );
    res.json({ granted: true });
  } catch (err) {
    console.error("Claim founding badge error:", err);
    res.status(500).json({ error: "Failed to claim badge" });
  }
});

// Admin: set or extend a member's free trial end date.
router.put("/admin/members/:email/trial", requireAdmin, async (req, res) => {
  const { trialEndsAt } = req.body as { trialEndsAt?: string };
  if (!trialEndsAt || !/^\d{4}-\d{2}-\d{2}$/.test(trialEndsAt)) {
    return res.status(400).json({ error: "trialEndsAt must be YYYY-MM-DD" });
  }
  const memberEmail = req.params.email.toLowerCase();
  try {
    const { rowCount } = await pool.query(
      `UPDATE members
         SET trial_ends_at = $1,
             trial_started_at = COALESCE(trial_started_at, now()),
             updated_at = now()
       WHERE email = $2`,
      [trialEndsAt, memberEmail]
    );
    if (!rowCount) return res.status(404).json({ error: "Member not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Update trial error:", err);
    res.status(500).json({ error: "Failed to update trial" });
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
      `SELECT m.email, m.name, m.avatar, m.trial_started_at, m.trial_ends_at, m.updated_at,
              COALESCE((SELECT SUM(al.points) FROM activity_logs al WHERE al.member_email = m.email), 0) AS well_cup_points
       FROM members m ORDER BY m.updated_at DESC`
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
        well_cup_points: Number(row.well_cup_points),
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

    if (grantTrial && trialEndsAt) {
      addTrialContactToBrevo(normalizedEmail, name.trim(), trialEndsAt)
        .catch((err) => console.error("Brevo trial sync (admin grant) failed:", err));
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Add member error:", err);
    res.status(500).json({ error: "Failed to add member" });
  }
});

// Admin: extend a member's trial by N days from today (minimum of current end date preserved).
router.patch("/admin/members/:email/trial", requireAdmin, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase().trim();
  const { days } = req.body as { days?: number };
  if (!days || days < 1 || days > 365) {
    return res.status(400).json({ error: "days must be 1–365" });
  }
  try {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + days);
    const trialEndsAt = trialEnd.toISOString().slice(0, 10);
    const { rowCount } = await pool.query(
      `UPDATE members
         SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, CURRENT_DATE), $1::date),
             trial_started_at = COALESCE(trial_started_at, now()),
             updated_at = now()
       WHERE email = $2`,
      [trialEndsAt, email]
    );
    if (!rowCount) return res.status(404).json({ error: "Member not found" });
    res.json({ ok: true, trialEndsAt });
  } catch (err) {
    console.error("Extend trial error:", err);
    res.status(500).json({ error: "Failed to extend trial" });
  }
});

// Includes badge fields so any page rendering another member's avatar
// (DMs, the new-message picker, forum posts/messages via deriveMemberId)
// can show their badge, not just the WELL Tribe pages.
router.get("/members", async (req, res) => {
  const excludeEmail = (req.query.excludeEmail as string | undefined)?.toLowerCase();

  try {
    const { rows } = await pool.query(
      `SELECT email, name, avatar, workout_log, featured_badge, created_at,
              CASE WHEN mood_status_expires_at > NOW() THEN mood_status ELSE NULL END AS mood_status
       FROM members
       WHERE email != $1
         AND (trial_ends_at IS NULL OR trial_ends_at >= CURRENT_DATE)
         AND (hidden_from_community IS NULL OR hidden_from_community = false)
       ORDER BY name ASC`,
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
          moodStatus: row.mood_status ?? null,
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

// Self-service account deletion — called by the member from their own device.
// Deletes all personal data across every table, then removes the member record.
// The members table has ON DELETE CASCADE for tribe_members, member_badges,
// tribe_cheers, tribe_cards, tribe_challenges — those clean up automatically.
router.delete("/members/self", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });
  const emailLower = email.toLowerCase();
  try {
    // Verify account exists before proceeding
    const { rows } = await pool.query("SELECT email FROM members WHERE email = $1", [emailLower]);
    if (rows.length === 0) return res.status(404).json({ error: "Account not found" });

    // Explicit deletes for tables without CASCADE
    await pool.query("DELETE FROM push_subscriptions WHERE user_email = $1", [emailLower]);
    await pool.query("DELETE FROM meal_plan_entries WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM saved_recipes WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM recipe_folders WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM meal_entries WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM sleep_entries WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM step_entries WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM activity_logs WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM login_streaks WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM well_cup_wins WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM coupon_redemptions WHERE user_id = $1", [emailLower]);
    await pool.query("DELETE FROM inspiration_reactions WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM event_rsvps WHERE member_email = $1", [emailLower]);
    await pool.query("UPDATE live_event_rsvps SET rsvps = array_remove(rsvps, $1)", [emailLower]);
    await pool.query("DELETE FROM messages WHERE sender_id = $1 OR recipient_id = $1", [emailLower]);
    await pool.query("DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1", [emailLower]);
    await pool.query("DELETE FROM referrals WHERE referrer_email = $1 OR referred_email = $1", [emailLower]);
    await pool.query("DELETE FROM analytics_events WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM member_notifications WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM saved_meals WHERE member_email = $1", [emailLower]);
    // These have ON DELETE CASCADE in the current schema, but tables created
    // before CASCADE was added keep their old constraints — delete explicitly
    // so the final members delete can never hit a foreign-key violation.
    await pool.query("DELETE FROM tribe_cheers WHERE sender_email = $1 OR recipient_email = $1", [emailLower]);
    await pool.query("DELETE FROM tribe_cards WHERE sender_email = $1 OR recipient_email = $1", [emailLower]);
    await pool.query("DELETE FROM tribe_challenges WHERE sender_email = $1 OR recipient_email = $1", [emailLower]);
    await pool.query("DELETE FROM tribe_members WHERE owner_email = $1 OR member_email = $1", [emailLower]);
    await pool.query("DELETE FROM member_badges WHERE member_email = $1", [emailLower]);
    await pool.query("DELETE FROM members WHERE email = $1", [emailLower]);

    res.json({ ok: true });
  } catch (err) {
    console.error("Self-delete account error:", err);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

// Remove a member from the shared directory (admin only) —
router.delete("/members/:email", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM members WHERE email = $1", [req.params.email.toLowerCase()]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete member error:", err);
    res.status(500).json({ error: "Failed to delete member" });
  }
});

// Let a member hide themselves from community member lists and discovery.
router.put("/members/community-visibility", async (req, res) => {
  const { email, hiddenFromCommunity } = req.body as { email?: string; hiddenFromCommunity?: boolean };
  if (!email || hiddenFromCommunity === undefined) {
    return res.status(400).json({ error: "email and hiddenFromCommunity required" });
  }
  try {
    await pool.query(
      "UPDATE members SET hidden_from_community = $1 WHERE email = $2",
      [hiddenFromCommunity, email.toLowerCase()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Community visibility error:", err);
    res.status(500).json({ error: "Failed to update community visibility" });
  }
});

// Let a member show or hide themselves from the WELL CUP leaderboard.
router.put("/members/leaderboard-visibility", async (req, res) => {
  const { email, showOnLeaderboard } = req.body as { email?: string; showOnLeaderboard?: boolean };
  if (!email || showOnLeaderboard === undefined) {
    return res.status(400).json({ error: "email and showOnLeaderboard required" });
  }
  try {
    await pool.query(
      "UPDATE members SET show_on_leaderboard = $1 WHERE email = $2",
      [showOnLeaderboard, email.toLowerCase()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Leaderboard visibility error:", err);
    res.status(500).json({ error: "Failed to update leaderboard visibility" });
  }
});

// Admin: manually fire the day-3 engagement email blast to all members who haven't received it
router.post("/admin/send-day3-blast", requireAdmin, async (_req, res) => {
  try {
    const result = await sendDay3EmailBlast();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Day-3 blast error:", err);
    res.status(500).json({ error: "Blast failed" });
  }
});

// Admin: reset day3_email_sent flag and re-blast to ALL members
router.post("/admin/force-day3-blast", requireAdmin, async (_req, res) => {
  try {
    await pool.query("UPDATE members SET day3_email_sent = FALSE");
    const result = await sendDay3EmailBlast();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Force day-3 blast error:", err);
    res.status(500).json({ error: "Blast failed" });
  }
});

// Admin: backfill last_monthly_win_at/pts for a specific past month's winner
// POST /api/members/admin/crown-previous-month  { year: 2026, month: 7 }
router.post("/admin/crown-previous-month", requireAdmin, async (req, res) => {
  const { year, month } = req.body as { year?: number; month?: number };
  if (!year || !month) return res.status(400).json({ error: "year and month required" });
  try {
    const monthStart = new Date(year, month - 1, 1).toISOString();
    const monthEnd = new Date(year, month, 1).toISOString();
    const { rows } = await pool.query<{ member_email: string; total: string }>(`
      SELECT member_email, SUM(points) AS total
      FROM activity_logs
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY member_email
      ORDER BY total DESC
      LIMIT 1
    `, [monthStart, monthEnd]);
    if (rows.length === 0) return res.status(404).json({ error: "No activity found for that month" });
    const winner = rows[0];
    const winAt = new Date(year, month - 1, 28, 23, 45, 0).toISOString(); // last day of month ~11:45pm
    await pool.query(
      `UPDATE members SET last_monthly_win_at = $2, last_monthly_win_pts = $3 WHERE email = $1`,
      [winner.member_email, winAt, Math.round(Number(winner.total))]
    );
    res.json({ ok: true, winner: winner.member_email, total: Math.round(Number(winner.total)) });
  } catch (err) {
    console.error("Crown previous month error:", err);
    res.status(500).json({ error: "Failed to backfill monthly winner" });
  }
});

// ─── Campaign endpoints ───────────────────────────────────────────────────────

const VIDEOLIBRARY_URL = process.env.VIDEOLIBRARY_URL || "https://videolibrary.lorettabates.com";
const WELL_API_KEY = process.env.WELL_API_KEY || "";

// POST /api/admin/mark-monthly-winner  { email, month: "YYYY-MM" }
// Manually sets last_monthly_win_at for a member (for cases where the scheduler ran
// while the member was invisible and didn't record the win).
router.post("/admin/mark-monthly-winner", requireAdmin, async (req, res) => {
  const { email, month } = req.body as { email?: string; month?: string };
  if (!email || !month) return res.status(400).json({ error: "email and month required" });
  try {
    const { rowCount } = await pool.query(
      `UPDATE members SET last_monthly_win_at = $2::timestamptz WHERE email = $1`,
      [email.toLowerCase(), `${month}-15T12:00:00Z`]
    );
    if (!rowCount) return res.status(404).json({ error: "Member not found" });
    res.json({ ok: true, email, last_monthly_win_at: `${month}-01` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/admin/wp-members-raw — temporary debug: raw WP member list without comparison
router.get("/admin/wp-members-raw", requireAdmin, async (_req, res) => {
  try {
    const wpRes = await fetch(
      `${VIDEOLIBRARY_URL}/wp-json/well/v1/all-members`,
      { headers: { "X-WELL-API-KEY": WELL_API_KEY }, signal: AbortSignal.timeout(15000) }
    );
    const body = await wpRes.text();
    if (!wpRes.ok) return res.status(502).json({ status: wpRes.status, body: body.slice(0, 500) });
    res.json(JSON.parse(body));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/admin/campaign-preview
// Fetches active + lapsed WP members, compares with app member list, returns both groups.
router.get("/admin/campaign-preview", requireAdmin, async (_req, res) => {
  try {
    // 1. Fetch all UMP members from the video library WordPress
    const wpRes = await fetch(
      `${VIDEOLIBRARY_URL}/wp-json/well/v1/all-members`,
      { headers: { "X-WELL-API-KEY": WELL_API_KEY }, signal: AbortSignal.timeout(15000) }
    );
    if (!wpRes.ok) {
      return res.status(502).json({ error: `WordPress returned ${wpRes.status} — is the well/v1/all-members snippet installed?` });
    }
    const wpData = (await wpRes.json()) as { members: Array<{ email: string; name: string; active: boolean }> };
    const wpMembers = wpData.members ?? [];

    // 2. Load all app member emails
    const { rows: appRows } = await pool.query<{ email: string; name: string; membership_status: string; trial_ends_at: string | null }>(
      "SELECT email, name, membership_status, trial_ends_at::text FROM members"
    );
    const appEmails = new Set(appRows.map((r) => r.email.toLowerCase()));

    // Group A: active WP members not yet on the app
    const notOnApp = wpMembers
      .filter((m) => m.active && !appEmails.has(m.email.toLowerCase()))
      .map((m) => ({ email: m.email, name: m.name }));

    // Group B: lapsed WP members (was WP subscriber, now inactive)
    const lapsed = wpMembers
      .filter((m) => !m.active)
      .map((m) => ({ email: m.email, name: m.name }));

    res.json({ notOnApp, lapsed });
  } catch (err) {
    console.error("Campaign preview error:", err);
    res.status(500).json({ error: "Failed to load campaign preview" });
  }
});

// POST /api/admin/campaign-send-app-invite  { emails: [{email, name}] }
router.post("/admin/campaign-send-app-invite", requireAdmin, async (req, res) => {
  const { emails } = req.body as { emails?: Array<{ email: string; name: string }> };
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: "emails array required" });
  }
  const { sendAppInviteEmail } = await import("../brevo");
  let sent = 0;
  const errors: string[] = [];
  for (const { email, name } of emails) {
    try {
      await sendAppInviteEmail(email, name);
      await pool.query(
        `INSERT INTO campaign_emails (email, name, campaign_type) VALUES ($1, $2, 'app-invite')`,
        [email.toLowerCase(), name]
      );
      sent++;
    } catch (err) {
      errors.push(email);
      console.error(`App invite email failed for ${email}:`, err);
    }
  }
  res.json({ sent, errors });
});

// POST /api/admin/campaign-send-winback  { emails: [{email, name}], referralCode: string }
router.post("/admin/campaign-send-winback", requireAdmin, async (req, res) => {
  const { emails, referralCode } = req.body as { emails?: Array<{ email: string; name: string }>; referralCode?: string };
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: "emails array required" });
  }
  if (!referralCode) {
    return res.status(400).json({ error: "referralCode required" });
  }
  const { sendMemberWinbackEmail } = await import("../brevo");
  let sent = 0;
  const errors: string[] = [];
  for (const { email, name } of emails) {
    try {
      await sendMemberWinbackEmail(email, name, referralCode);
      await pool.query(
        `INSERT INTO campaign_emails (email, name, campaign_type) VALUES ($1, $2, 'winback')`,
        [email.toLowerCase(), name]
      );
      sent++;
    } catch (err) {
      errors.push(email);
      console.error(`Winback email failed for ${email}:`, err);
    }
  }
  res.json({ sent, errors });
});

// POST /api/admin/campaign-send-notification-optin
// Sends "Did you get my message?" to all members to encourage push notification opt-in.
// Returns { total, sent, errors }.
router.post("/admin/campaign-send-notification-optin", requireAdmin, async (_req, res) => {
  const { sendNotificationOptInEmail } = await import("../brevo");
  try {
    const { rows } = await pool.query<{ email: string; name: string }>(
      `SELECT email, name FROM members WHERE email IS NOT NULL ORDER BY name ASC`
    );

    let sent = 0;
    const errors: string[] = [];

    for (const { email, name } of rows) {
      try {
        await sendNotificationOptInEmail(email, name);
        await pool.query(
          `INSERT INTO campaign_emails (email, name, campaign_type) VALUES ($1, $2, 'notification-optin')`,
          [email.toLowerCase(), name]
        );
        sent++;
      } catch (err) {
        errors.push(email);
        console.error(`Notification opt-in email failed for ${email}:`, err);
      }
    }

    res.json({ total: rows.length, sent, errors });
  } catch (err) {
    console.error("Notification opt-in campaign error:", err);
    res.status(500).json({ error: "Failed to send notification opt-in campaign" });
  }
});

// POST /api/admin/campaign-send-trial-resume-winback
// Auto-discovers all lapsed < 30-day trial members who haven't been emailed
// yet and blasts the "your days are still waiting" win-back email to them.
// Returns { eligible, sent, alreadySent, errors }.
router.post("/admin/campaign-send-trial-resume-winback", requireAdmin, async (_req, res) => {
  const { sendTrialResumeWinbackEmail } = await import("../brevo");
  try {
    const { rows } = await pool.query<{
      email: string;
      name: string;
      trial_started_at: Date;
      trial_ends_at: Date;
    }>(
      `SELECT email, name, trial_started_at, trial_ends_at
       FROM members
       WHERE trial_started_at IS NOT NULL
         AND trial_ends_at IS NOT NULL
         AND trial_ends_at < CURRENT_DATE
         AND trial_resumed_at IS NULL
         AND (membership_status IS NULL OR membership_status != 'active')
         AND ROUND(EXTRACT(EPOCH FROM (trial_ends_at - trial_started_at)) / 86400) < 30
       ORDER BY trial_ends_at DESC`
    );

    const { rows: alreadySentRows } = await pool.query<{ email: string }>(
      `SELECT DISTINCT email FROM campaign_emails WHERE campaign_type = 'trial-resume-winback'`
    );
    const alreadySentEmails = new Set(alreadySentRows.map((r) => r.email.toLowerCase()));

    let sent = 0;
    let alreadySent = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const email = row.email.toLowerCase();
      if (alreadySentEmails.has(email)) { alreadySent++; continue; }
      const daysUsed = Math.round(
        (row.trial_ends_at.getTime() - row.trial_started_at.getTime()) / (1000 * 60 * 60 * 24)
      );
      try {
        await sendTrialResumeWinbackEmail(email, row.name, daysUsed);
        await pool.query(
          `INSERT INTO campaign_emails (email, name, campaign_type) VALUES ($1, $2, 'trial-resume-winback')`,
          [email, row.name]
        );
        sent++;
      } catch (err) {
        errors.push(email);
        console.error(`Trial resume winback failed for ${email}:`, err);
      }
    }

    res.json({ eligible: rows.length, sent, alreadySent, errors });
  } catch (err) {
    console.error("Trial resume winback blast error:", err);
    res.status(500).json({ error: "Failed to run trial resume winback blast" });
  }
});

// POST /api/admin/campaign-backfill  { entries: [{email, name, campaignType, sentAt?}] }
router.post("/admin/campaign-backfill", requireAdmin, async (req, res) => {
  const { entries } = req.body as { entries?: Array<{ email: string; name: string; campaignType: string; sentAt?: string }> };
  if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: "entries array required" });
  let inserted = 0;
  for (const { email, name, campaignType, sentAt } of entries) {
    await pool.query(
      `INSERT INTO campaign_emails (email, name, campaign_type, sent_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [email.toLowerCase(), name, campaignType, sentAt ? new Date(sentAt) : new Date()]
    );
    inserted++;
  }
  res.json({ inserted });
});

// GET /api/admin/campaign-history  — log of every campaign email sent
router.get("/admin/campaign-history", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT email, name, campaign_type, sent_at
      FROM campaign_emails
      ORDER BY sent_at DESC
      LIMIT 500
    `);
    res.json({ history: rows });
  } catch (err) {
    console.error("Campaign history error:", err);
    res.status(500).json({ error: "Failed to load campaign history" });
  }
});

// GET /api/admin/push-diagnostic/:email  — check push subscription for a member
router.get("/admin/push-diagnostic/:email", requireAdmin, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  try {
    const { rows } = await pool.query(
      "SELECT endpoint, created_at FROM push_subscriptions WHERE user_email = $1 ORDER BY created_at DESC",
      [email]
    );
    const appMember = await pool.query("SELECT name, membership_status, trial_ends_at::text FROM members WHERE email = $1", [email]);
    res.json({
      email,
      member: appMember.rows[0] ?? null,
      subscriptionCount: rows.length,
      subscriptions: rows.map((r) => ({
        platform: r.endpoint.includes("fcm") || r.endpoint.includes("googleapis") ? "Android/Chrome" :
                  r.endpoint.includes("mozilla") ? "Firefox" :
                  r.endpoint.includes("apple") ? "Safari/iOS" : "Unknown",
        endpoint: r.endpoint.slice(0, 60) + "…",
        registeredAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Push diagnostic error:", err);
    res.status(500).json({ error: "Failed to load push diagnostic" });
  }
});

// POST /api/admin/prune-tribe-now  — manually trigger tribe prune
router.post("/admin/prune-tribe-now", requireAdmin, async (_req, res) => {
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM tribe_members
      WHERE member_email IN (
        SELECT email FROM members
        WHERE (membership_status IS NULL OR membership_status != 'active')
          AND (trial_ends_at IS NULL OR trial_ends_at < CURRENT_DATE)
      )
    `);
    res.json({ ok: true, removed: rowCount ?? 0 });
  } catch (err) {
    console.error("Manual tribe prune error:", err);
    res.status(500).json({ error: "Failed to prune tribe" });
  }
});

// POST /api/admin/send-rating-notifications
// Sends push notifications to members who joined 7+ days ago. For members
// with no push subscription, sets rating_prompt_pending so the in-app
// dialog fires next time they open the app.
router.post("/admin/send-rating-notifications", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query<{ email: string; name: string }>(
      `SELECT email, name FROM members
       WHERE trial_started_at <= now() - INTERVAL '7 days'
         AND email NOT IN (SELECT unnest($1::text[]))
       ORDER BY trial_started_at`,
      [ADMIN_NOTIFY_EMAILS]
    );

    const { rows: subRows } = await pool.query<{ user_email: string }>(
      `SELECT DISTINCT user_email FROM push_subscriptions WHERE user_email IS NOT NULL`
    );
    const subscribedEmails = new Set(subRows.map((r) => r.user_email.toLowerCase()));

    let sent = 0;
    let skipped = 0;
    const needsInAppPrompt: string[] = [];

    for (const { email, name } of rows) {
      if (subscribedEmails.has(email.toLowerCase())) {
        try {
          const result = await sendNotificationToUser(email, {
            title: "Loving the app?",
            body: `${name.split(" ")[0]}, your rating helps other women find the community. Tap to leave a review!`,
            tag: "rate-app",
            url: "/rate-app",
          });
          if (result.sent > 0) sent++;
          else skipped++;
        } catch {
          skipped++;
        }
      } else {
        needsInAppPrompt.push(email);
      }
    }

    // Flag members without push so the app shows the dialog on next open
    if (needsInAppPrompt.length > 0) {
      await pool.query(
        `UPDATE members SET rating_prompt_pending = TRUE WHERE email = ANY($1::text[])`,
        [needsInAppPrompt]
      );
    }

    res.json({
      ok: true,
      eligible: rows.length,
      sent,
      skipped,
      inAppPromptSet: needsInAppPrompt.length,
    });
  } catch (err) {
    console.error("Rating notification blast error:", err);
    res.status(500).json({ error: "Failed to send rating notifications" });
  }
});

// POST /api/members/clear-rating-prompt — called by app after showing the dialog
router.post("/members/clear-rating-prompt", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: "email required" });
  await pool.query(
    `UPDATE members SET rating_prompt_pending = FALSE WHERE email = $1`,
    [email.toLowerCase()]
  );
  res.json({ ok: true });
});

export default router;
