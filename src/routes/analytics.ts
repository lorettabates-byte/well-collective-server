import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

// Client-side event tracking — any authenticated member can log events.
// No auth required so it works even during trial/offline-token sessions.
router.post("/analytics/event", async (req, res) => {
  try {
    const { email, eventType, metadata } = req.body as {
      email?: string;
      eventType?: string;
      metadata?: Record<string, unknown>;
    };
    if (!email || !eventType) {
      return res.status(400).json({ error: "email and eventType required" });
    }
    await pool.query(
      `INSERT INTO analytics_events (member_email, event_type, metadata)
       VALUES ($1, $2, $3)`,
      [email, eventType, metadata ? JSON.stringify(metadata) : null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Analytics event error:", err);
    res.json({ ok: false });
  }
});

// Admin dashboard — all aggregated analytics in one request.
router.get("/analytics/dashboard", requireAdmin, async (_req, res) => {
  try {
    // ── Daily active users — last 14 days ─────────────────────────────
    const { rows: dauRows } = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC') AS day,
        COUNT(DISTINCT member_email) AS users
      FROM analytics_events
      WHERE event_type = 'app_open'
        AND created_at >= NOW() - INTERVAL '14 days'
      GROUP BY day
      ORDER BY day
    `);

    // ── Section visit counts — last 30 days ───────────────────────────
    const { rows: sectionRows } = await pool.query(`
      SELECT
        metadata->>'section' AS section,
        COUNT(*) AS visits,
        COUNT(DISTINCT member_email) AS unique_users
      FROM analytics_events
      WHERE event_type = 'section_visit'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY section
      ORDER BY visits DESC
    `);

    // ── Login counts — last 14 days ───────────────────────────────────
    const { rows: loginRows } = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*) AS logins,
        COUNT(DISTINCT member_email) AS unique_users
      FROM analytics_events
      WHERE event_type = 'login'
        AND created_at >= NOW() - INTERVAL '14 days'
      GROUP BY day
      ORDER BY day
    `);

    // ── Session duration — last 30 days ───────────────────────────────
    const { rows: sessionRows } = await pool.query(`
      SELECT
        AVG((metadata->>'duration_seconds')::int) AS avg_seconds,
        MAX((metadata->>'duration_seconds')::int) AS max_seconds,
        COUNT(*) AS count
      FROM analytics_events
      WHERE event_type = 'session_end'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND metadata->>'duration_seconds' IS NOT NULL
    `);

    // ── Tutorial funnel ───────────────────────────────────────────────
    const { rows: tutorialStepRows } = await pool.query(`
      SELECT
        (metadata->>'step')::int AS step,
        (array_agg(metadata->>'slide_title' ORDER BY created_at DESC))[1] AS slide_title,
        COUNT(DISTINCT member_email) AS users
      FROM analytics_events
      WHERE event_type = 'tutorial_step'
      GROUP BY step
      ORDER BY step
    `);

    const { rows: tutorialOutcomeRows } = await pool.query(`
      SELECT event_type AS outcome, COUNT(*) AS count
      FROM analytics_events
      WHERE event_type IN ('tutorial_complete', 'tutorial_skip')
      GROUP BY event_type
    `);

    const { rows: tutorialSkipRows } = await pool.query(`
      SELECT
        (metadata->>'at_step')::int AS at_step,
        metadata->>'slide_title' AS slide_title,
        COUNT(*) AS count
      FROM analytics_events
      WHERE event_type = 'tutorial_skip'
      GROUP BY at_step, slide_title
      ORDER BY at_step
    `);

    // ── WELL Cup by activity type — last 30 days ──────────────────────
    const { rows: wellCupRows } = await pool.query(`
      SELECT
        activity_type,
        SUM(points) AS total_points,
        COUNT(*) AS events,
        COUNT(DISTINCT member_email) AS unique_earners
      FROM activity_logs
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND activity_type != 'login_streak_bonus'
      GROUP BY activity_type
      ORDER BY total_points DESC
    `);

    // ── WELL Cup per-member — top 20 last 30 days ─────────────────────
    const { rows: wellCupMemberRows } = await pool.query(`
      SELECT
        al.member_email,
        m.name,
        SUM(al.points) AS total_points,
        COUNT(*) AS events
      FROM activity_logs al
      LEFT JOIN members m ON m.email = al.member_email
      WHERE al.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY al.member_email, m.name
      ORDER BY total_points DESC
      LIMIT 20
    `);

    // ── Recent individual WELL Cup events — last 200 ──────────────────
    const { rows: wellCupRecentRows } = await pool.query(`
      SELECT
        al.member_email,
        m.name,
        al.activity_type,
        al.points,
        al.metadata,
        al.created_at
      FROM activity_logs al
      LEFT JOIN members m ON m.email = al.member_email
      ORDER BY al.created_at DESC
      LIMIT 200
    `);

    // ── Overall summary ───────────────────────────────────────────────
    const { rows: summaryRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'app_open') AS total_app_opens,
        COUNT(*) FILTER (WHERE event_type = 'login') AS total_logins,
        COUNT(*) FILTER (WHERE event_type = 'session_end') AS total_sessions,
        COUNT(DISTINCT member_email) FILTER (
          WHERE event_type = 'app_open' AND created_at >= NOW() - INTERVAL '7 days'
        ) AS wau,
        COUNT(DISTINCT member_email) FILTER (
          WHERE event_type = 'app_open' AND created_at >= NOW() - INTERVAL '1 day'
        ) AS dau_today
      FROM analytics_events
    `);

    // ── Retention cohorts: D1 / D3 / D7 / D14 / D30 ──────────────────
    // For each window N: how many members who first opened the app more than
    // N days ago have also opened it on or after day N from their first open?
    const { rows: retentionRows } = await pool.query(`
      WITH first_open AS (
        SELECT member_email, MIN(created_at) AS first_at
        FROM analytics_events
        WHERE event_type = 'app_open'
        GROUP BY member_email
      ),
      windows AS (
        SELECT * FROM (VALUES (1),(3),(7),(14),(30)) AS t(n)
      )
      SELECT
        w.n AS day,
        COUNT(DISTINCT fo.member_email) AS cohort_size,
        COUNT(DISTINCT ae.member_email) AS retained,
        ROUND(
          100.0 * COUNT(DISTINCT ae.member_email)
            / NULLIF(COUNT(DISTINCT fo.member_email), 0),
          1
        ) AS pct
      FROM windows w
      CROSS JOIN first_open fo
      LEFT JOIN analytics_events ae
        ON ae.member_email = fo.member_email
        AND ae.event_type = 'app_open'
        AND ae.created_at >= fo.first_at + (w.n || ' days')::interval
      WHERE fo.first_at <= NOW() - (w.n || ' days')::interval
      GROUP BY w.n
      ORDER BY w.n
    `);

    // ── Per-member activity summary ────────────────────────────────────
    const { rows: memberStatsRows } = await pool.query(`
      SELECT
        m.email AS member_email,
        m.name,
        COUNT(DISTINCT ae.id) FILTER (WHERE ae.event_type = 'app_open') AS app_opens,
        COUNT(DISTINCT ae.id) FILTER (WHERE ae.event_type = 'section_visit') AS section_visits,
        COALESCE(SUM(al.points), 0) AS total_points,
        MAX(ae.created_at) AS last_seen,
        ls.current_streak,
        ls.longest_streak
      FROM members m
      LEFT JOIN analytics_events ae ON ae.member_email = m.email
      LEFT JOIN activity_logs al ON al.member_email = m.email
      LEFT JOIN login_streaks ls ON ls.member_email = m.email
      GROUP BY m.email, m.name, ls.current_streak, ls.longest_streak
      ORDER BY last_seen DESC NULLS LAST
    `);

    // ── Section visits per member (for per-user drilldown) ─────────────
    const { rows: memberSectionRows } = await pool.query(`
      SELECT
        member_email,
        metadata->>'section' AS section,
        COUNT(*) AS visits
      FROM analytics_events
      WHERE event_type = 'section_visit'
        AND metadata->>'section' IS NOT NULL
      GROUP BY member_email, section
      ORDER BY member_email, visits DESC
    `);

    // ── Forum activity by category ─────────────────────────────────────
    const { rows: forumCategoryRows } = await pool.query(`
      SELECT
        fc.name AS category_name,
        fc.sort_order,
        COUNT(DISTINCT ft.id) AS threads,
        COUNT(DISTINCT fm.id) AS messages,
        COUNT(DISTINCT fm.author_id) AS unique_authors
      FROM forum_categories fc
      LEFT JOIN forum_threads ft ON ft.category_id = fc.id
      LEFT JOIN forum_messages fm ON fm.thread_id = ft.id
      GROUP BY fc.id, fc.name, fc.sort_order
      ORDER BY fc.sort_order
    `);

    // ── RSVP log — all-time from event_rsvps table ─────────────────────
    const { rows: rsvpLogRows } = await pool.query(`
      SELECT
        er.member_email,
        m.name,
        er.event_id,
        e.title AS event_title,
        e.date AS event_date,
        er.created_at
      FROM event_rsvps er
      JOIN members m ON m.email = er.member_email
      JOIN events e ON e.id = er.event_id
      ORDER BY er.created_at DESC
      LIMIT 200
    `);

    // ── Analytics RSVP events (add/cancel history) ────────────────────
    const { rows: rsvpEventRows } = await pool.query(`
      SELECT
        member_email,
        metadata->>'action' AS action,
        metadata->>'eventTitle' AS event_title,
        created_at
      FROM analytics_events
      WHERE event_type = 'event_rsvp'
      ORDER BY created_at DESC
      LIMIT 200
    `);

    // ── Login streaks — all members with an active streak ─────────────
    const { rows: streakRows } = await pool.query(`
      SELECT
        ls.member_email,
        m.name,
        ls.current_streak,
        ls.longest_streak,
        ls.last_login_date::text AS last_login_date
      FROM login_streaks ls
      JOIN members m ON m.email = ls.member_email
      ORDER BY ls.current_streak DESC, ls.longest_streak DESC
    `);

    // ── WELL Cup streak bonus totals ───────────────────────────────────
    const { rows: streakBonusRows } = await pool.query(`
      SELECT
        al.member_email,
        m.name,
        SUM(al.points) AS total_bonus_pts,
        COUNT(*) AS streak_days
      FROM activity_logs al
      LEFT JOIN members m ON m.email = al.member_email
      WHERE al.activity_type = 'login_streak_bonus'
      GROUP BY al.member_email, m.name
      ORDER BY total_bonus_pts DESC
    `);

    res.json({
      summary: summaryRows[0],
      dau: dauRows,
      logins: loginRows,
      sessions: sessionRows[0] ?? null,
      sectionVisits: sectionRows,
      tutorialSteps: tutorialStepRows,
      tutorialOutcomes: tutorialOutcomeRows,
      tutorialSkips: tutorialSkipRows,
      wellCupByType: wellCupRows,
      wellCupByMember: wellCupMemberRows,
      wellCupRecent: wellCupRecentRows,
      retention: retentionRows,
      memberStats: memberStatsRows,
      memberSections: memberSectionRows,
      forumByCategory: forumCategoryRows,
      rsvpLog: rsvpLogRows,
      rsvpEvents: rsvpEventRows,
      streaks: streakRows,
      streakBonuses: streakBonusRows,
    });
  } catch (err) {
    console.error("Analytics dashboard error:", err);
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

export default router;
