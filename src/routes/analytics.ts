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
    // Never surface errors to the client — analytics failures are silent
    console.error("Analytics event error:", err);
    res.json({ ok: false });
  }
});

// Admin dashboard — returns all aggregated analytics in one request.
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
        COUNT(*) AS total_sessions
      FROM analytics_events
      WHERE event_type = 'session_end'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND metadata->>'duration_seconds' IS NOT NULL
    `);

    // ── Tutorial funnel — how many users reached each step ────────────
    const { rows: tutorialStepRows } = await pool.query(`
      SELECT
        (metadata->>'step')::int AS step,
        metadata->>'slide_title' AS slide_title,
        COUNT(DISTINCT member_email) AS users
      FROM analytics_events
      WHERE event_type = 'tutorial_step'
      GROUP BY step, slide_title
      ORDER BY step
    `);

    // ── Tutorial outcomes ─────────────────────────────────────────────
    const { rows: tutorialOutcomeRows } = await pool.query(`
      SELECT event_type, COUNT(*) AS count
      FROM analytics_events
      WHERE event_type IN ('tutorial_complete', 'tutorial_skip')
      GROUP BY event_type
    `);

    // ── Tutorial skip points — where do people drop off? ─────────────
    const { rows: tutorialSkipRows } = await pool.query(`
      SELECT
        (metadata->>'at_step')::int AS at_step,
        metadata->>'slide_title' AS slide_title,
        COUNT(*) AS skips
      FROM analytics_events
      WHERE event_type = 'tutorial_skip'
      GROUP BY at_step, slide_title
      ORDER BY at_step
    `);

    // ── WELL Cup points by activity type — last 30 days ───────────────
    const { rows: wellCupRows } = await pool.query(`
      SELECT
        activity_type,
        SUM(points) AS total_points,
        COUNT(*) AS events,
        COUNT(DISTINCT member_email) AS unique_earners
      FROM activity_logs
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY activity_type
      ORDER BY total_points DESC
    `);

    // ── WELL Cup per-member breakdown — top 20 earners last 30 days ───
    const { rows: wellCupMemberRows } = await pool.query(`
      SELECT
        al.member_email,
        m.name,
        SUM(al.points) AS total_points,
        COUNT(*) AS activities
      FROM activity_logs al
      LEFT JOIN members m ON m.email = al.member_email
      WHERE al.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY al.member_email, m.name
      ORDER BY total_points DESC
      LIMIT 20
    `);

    // ── Recent individual WELL Cup point events — last 100 ────────────
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
      LIMIT 100
    `);

    // ── Overall summary counts ────────────────────────────────────────
    const { rows: summaryRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'app_open') AS total_app_opens,
        COUNT(*) FILTER (WHERE event_type = 'login') AS total_logins,
        COUNT(*) FILTER (WHERE event_type = 'session_end') AS total_sessions,
        COUNT(DISTINCT member_email) FILTER (WHERE event_type = 'app_open' AND created_at >= NOW() - INTERVAL '7 days') AS wau,
        COUNT(DISTINCT member_email) FILTER (WHERE event_type = 'app_open' AND created_at >= NOW() - INTERVAL '1 day') AS dau_today
      FROM analytics_events
    `);

    res.json({
      summary: summaryRows[0],
      dau: dauRows,
      logins: loginRows,
      sessions: sessionRows[0] ?? { avg_seconds: 0, max_seconds: 0, total_sessions: 0 },
      sectionVisits: sectionRows,
      tutorialSteps: tutorialStepRows,
      tutorialOutcomes: tutorialOutcomeRows,
      tutorialSkips: tutorialSkipRows,
      wellCupByType: wellCupRows,
      wellCupByMember: wellCupMemberRows,
      wellCupRecent: wellCupRecentRows,
    });
  } catch (err) {
    console.error("Analytics dashboard error:", err);
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

export default router;
