import cron from "node-cron";
import {
  generateDailyInspiration,
  generateMotivationBoost,
  generateNutritionTip,
  generateRecipe,
  generateWeeklyTheme,
  generateWellActivity,
  isAnthropicConfigured,
} from "./anthropic";
import { checkForNewBlogPosts } from "./routes/blog-notifications";
import { checkForNewLiveEvents } from "./routes/live-event-notifications";
import { checkForNewVideos } from "./routes/video-notifications";
import { pool } from "./db";
import { broadcastNotification, sendNotificationToUser } from "./push";
import { computeNutritionFromIngredients, isUsdaConfigured } from "./usda";
import { addTrialContactToBrevo, moveTrialContactToCompleted, sendMidTrialEmail, sendTrialExpiredEmail } from "./brevo";
import { awardPoints } from "./routes/points";
import { TIMEZONE, todayInTimezone, addDays, SQL_DAY_START, SQL_MONTH_START } from "./dateUtils";

// Weekly themes are only stored on the Monday row, so to find "this week's"
// theme from any day we scan backward up to 7 days for the most recent one.
async function findCurrentWeeklyThemeTitle(date: string): Promise<string | undefined> {
  for (let i = 0; i < 7; i++) {
    const checkDate = addDays(date, -i);
    const { rows } = await pool.query("SELECT weekly_theme FROM content_schedule WHERE date = $1", [checkDate]);
    const theme = rows[0]?.weekly_theme as { title?: string } | undefined;
    if (theme?.title) return theme.title;
  }
  return undefined;
}

function mostRecentMonday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export async function generateAIContent(): Promise<void> {
  if (!isAnthropicConfigured()) {
    console.log("[SCHEDULER] Skipping AI content generation — ANTHROPIC_API_KEY not configured");
    return;
  }
  if (!isUsdaConfigured()) {
    console.log("[SCHEDULER] FDC_API_KEY not configured — recipe nutrition will fall back to the AI's own estimate");
  }

  const date = todayInTimezone();
  console.log(`[SCHEDULER] AI content generation check for ${date}`);

  const { rows } = await pool.query(
    "SELECT daily_inspiration, recipe, motivation_boost, nutrition_tip, well_activity FROM content_schedule WHERE date = $1",
    [date]
  );
  const row = rows[0] as
    | {
        daily_inspiration?: { title?: string };
        recipe?: unknown;
        motivation_boost?: unknown;
        nutrition_tip?: string;
        well_activity?: unknown;
      }
    | undefined;

  // Yesterday's content, used so the AI prompts can be told not to repeat
  // themselves — without this, a multi-day weekly theme made it common for
  // the daily inspiration/recipe/well activity to land on near-identical
  // titles on consecutive days.
  const { rows: yesterdayRows } = await pool.query(
    "SELECT daily_inspiration, recipe, well_activity FROM content_schedule WHERE date = $1",
    [addDays(date, -1)]
  );
  const yesterdayRow = yesterdayRows[0] as
    | {
        daily_inspiration?: { title?: string };
        recipe?: { name?: string };
        well_activity?: { title?: string };
      }
    | undefined;

  // A week's worth of recent recipes, not just yesterday's — a single
  // "don't repeat yesterday" check still let near-identical oatmeal/porridge
  // dishes recur every other day. Passing the whole week's worth lets the
  // prompt actively steer toward different meal types and ingredients.
  const { rows: recentRecipeRows } = await pool.query(
    `SELECT recipe FROM content_schedule
     WHERE date < $1 AND date >= $2 AND recipe IS NOT NULL
     ORDER BY date DESC`,
    [date, addDays(date, -7)]
  );
  const recentRecipes = recentRecipeRows
    .map((r) => r.recipe as { name?: string; imageCategory?: string })
    .filter((r) => r.name)
    .map((r) => ({ name: r.name as string, imageCategory: r.imageCategory }));

  let weeklyThemeTitle = await findCurrentWeeklyThemeTitle(date);

  if (!weeklyThemeTitle) {
    try {
      // Weekly themes are only ever stored on the Monday row, so the last
      // ~8 weeks of Mondays covers recent history without scanning every day.
      const { rows: recentThemeRows } = await pool.query(
        `SELECT weekly_theme FROM content_schedule
         WHERE date < $1 AND date >= $2 AND weekly_theme IS NOT NULL
         ORDER BY date DESC`,
        [date, addDays(date, -56)]
      );
      const recentThemes = recentThemeRows
        .map((r) => (r.weekly_theme as { title?: string })?.title)
        .filter((t): t is string => !!t);

      const theme = await generateWeeklyTheme(recentThemes);
      const monday = mostRecentMonday(date);
      await pool.query(
        `INSERT INTO content_schedule (date, weekly_theme) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET weekly_theme = COALESCE(content_schedule.weekly_theme, $2)`,
        [monday, JSON.stringify(theme)]
      );
      weeklyThemeTitle = theme.title;
      console.log(`[SCHEDULER] Generated AI weekly theme: "${theme.title}"`);
    } catch (err) {
      console.error("[SCHEDULER] Weekly theme generation failed:", err);
    }
  }

  if (!row?.daily_inspiration) {
    try {
      const inspiration = await generateDailyInspiration(weeklyThemeTitle, yesterdayRow?.daily_inspiration?.title);
      await pool.query(
        `INSERT INTO content_schedule (date, daily_inspiration) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET daily_inspiration = COALESCE(content_schedule.daily_inspiration, $2)`,
        [date, JSON.stringify(inspiration)]
      );
      console.log(`[SCHEDULER] Generated AI daily inspiration: "${inspiration.title}"`);
    } catch (err) {
      console.error("[SCHEDULER] Daily inspiration generation failed:", err);
    }
  }

  if (!row?.motivation_boost) {
    try {
      const boost = await generateMotivationBoost(weeklyThemeTitle, row?.daily_inspiration?.title);
      await pool.query(
        `INSERT INTO content_schedule (date, motivation_boost) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET motivation_boost = $2`,
        [date, JSON.stringify(boost)]
      );
      console.log(`[SCHEDULER] Generated AI motivation boost: "${boost.title}"`);
    } catch (err) {
      console.error("[SCHEDULER] Motivation boost generation failed:", err);
    }
  }

  if (!row?.recipe) {
    try {
      const recipe = await generateRecipe(weeklyThemeTitle, recentRecipes);

      // Prefer real USDA-measured nutrition over the AI's own estimate —
      // only falls back to the AI's guess if FDC_API_KEY isn't configured
      // or none of the ingredients resolved in the database.
      const usdaNutrition = await computeNutritionFromIngredients(recipe.nutritionLookup);
      const { verified, ...usdaTotals } = usdaNutrition ?? { verified: false };
      const finalRecipe = {
        ...recipe,
        nutrition: usdaNutrition ? usdaTotals : recipe.nutrition,
        nutritionVerified: usdaNutrition ? verified : false,
      };

      await pool.query(
        `INSERT INTO content_schedule (date, recipe) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET recipe = COALESCE(content_schedule.recipe, $2)`,
        [date, JSON.stringify(finalRecipe)]
      );
      console.log(
        `[SCHEDULER] Generated AI recipe: "${recipe.name}" (nutrition ${
          usdaNutrition ? (usdaNutrition.verified ? "USDA-verified" : "USDA-partial") : "AI estimate"
        })`
      );
    } catch (err) {
      console.error("[SCHEDULER] Recipe generation failed:", err);
    }
  }

  if (!row?.nutrition_tip) {
    try {
      const tip = await generateNutritionTip();
      await pool.query(
        `INSERT INTO content_schedule (date, nutrition_tip) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET nutrition_tip = $2`,
        [date, tip]
      );
      console.log(`[SCHEDULER] Generated AI nutrition tip: "${tip}"`);
    } catch (err) {
      console.error("[SCHEDULER] Nutrition tip generation failed:", err);
    }
  }

  if (!row?.well_activity) {
    try {
      const activity = await generateWellActivity(weeklyThemeTitle, yesterdayRow?.well_activity?.title);
      await pool.query(
        `INSERT INTO content_schedule (date, well_activity) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET well_activity = COALESCE(content_schedule.well_activity, $2)`,
        [date, JSON.stringify(activity)]
      );
      console.log(`[SCHEDULER] Generated AI WELL activity: "${activity.title}"`);
    } catch (err) {
      console.error("[SCHEDULER] WELL activity generation failed:", err);
    }
  }
}

async function alreadySent(date: string, kind: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM sent_log WHERE date = $1 AND kind = $2", [date, kind]);
  return rows.length > 0;
}

async function markSent(date: string, kind: string): Promise<void> {
  await pool.query(
    "INSERT INTO sent_log (date, kind) VALUES ($1, $2) ON CONFLICT (date, kind) DO NOTHING",
    [date, kind]
  );
}

async function sendWeeklyTheme(): Promise<void> {
  const date = todayInTimezone();
  console.log(`[SCHEDULER] Weekly theme check for ${date}`);

  if (await alreadySent(date, "weeklyTheme")) {
    console.log(`[SCHEDULER] Weekly theme already sent for ${date}`);
    return;
  }

  const { rows } = await pool.query("SELECT weekly_theme FROM content_schedule WHERE date = $1", [date]);
  const theme = rows[0]?.weekly_theme as { title: string; body: string } | undefined;

  if (!theme) {
    console.log(`[SCHEDULER] No weekly theme found in content_schedule for ${date}`);
    return;
  }

  console.log(`[SCHEDULER] Sending weekly theme: "${theme.title}"`);
  const result = await broadcastNotification({
    title: `This Week's Theme: ${theme.title}`,
    body: theme.body,
    tag: "weekly-theme",
    url: "/inspirations",
  });
  console.log(`[SCHEDULER] Weekly theme result:`, result);
  await markSent(date, "weeklyTheme");
}

async function sendDailyInspiration(): Promise<void> {
  const date = todayInTimezone();
  console.log(`[SCHEDULER] Daily inspiration check for ${date}`);

  if (await alreadySent(date, "dailyInspiration")) {
    console.log(`[SCHEDULER] Daily inspiration already sent for ${date}`);
    return;
  }

  const { rows } = await pool.query(
    "SELECT daily_inspiration, well_activity, nutrition_tip FROM content_schedule WHERE date = $1",
    [date]
  );
  const row = rows[0] as
    | { daily_inspiration?: { title: string; body: string }; well_activity?: { title?: string }; nutrition_tip?: string }
    | undefined;
  const inspiration = row?.daily_inspiration;

  if (!inspiration) {
    console.log(`[SCHEDULER] No daily inspiration found in content_schedule for ${date}`);
    return;
  }

  const extras: string[] = [];
  if (row?.nutrition_tip) extras.push(`🥗 Nutrition tip: ${row.nutrition_tip}`);
  if (row?.well_activity?.title) extras.push(`🧘 WELL Activity: ${row.well_activity.title}`);
  const body = extras.length > 0 ? `${inspiration.body}\n\n${extras.join("\n")}` : inspiration.body;

  console.log(`[SCHEDULER] Sending daily inspiration: "${inspiration.title}"`);
  const result = await broadcastNotification({
    title: inspiration.title,
    body,
    tag: "daily-inspiration",
    url: "/inspirations",
  });
  console.log(`[SCHEDULER] Daily inspiration result:`, result);
  await markSent(date, "dailyInspiration");
}

async function sendLivestreamReminder(): Promise<void> {
  const date = todayInTimezone();
  if (await alreadySent(date, "livestreamReminder")) return;

  // Scheduled ahead of time from the admin panel — sends a cancellation
  // notice instead of the normal reminder, using the same sent_log kind so
  // only one of the two ever goes out for a given day.
  const { rows } = await pool.query(
    "SELECT reason FROM livestream_cancellations WHERE date = $1",
    [date]
  );
  if (rows.length > 0) {
    const reason = rows[0].reason as string | null;
    await broadcastNotification({
      title: "Today's Live Cardio Class is Cancelled",
      body: reason
        ? `No live class today — ${reason}. See you next time!`
        : "No live class today. See you next time!",
      tag: "livestream-reminder",
      url: "/videos",
    });
    await markSent(date, "livestreamReminder");
    return;
  }

  await broadcastNotification({
    title: "WELL Collective Live Cardio Class",
    body: "Join us in 1 hour for a fun live cardio class! Get ready to move and connect with the community. 💪",
    tag: "livestream-reminder",
    url: "/videos",
  });
  await markSent(date, "livestreamReminder");
}

// Safety net for the exact-time Tuesday 8am cron above — if that single tick
// gets missed (e.g. Railway restarts/redeploys the server right around 8am,
// and node-cron doesn't catch up on schedules it wasn't running for), the
// reminder would otherwise silently never send for the whole week. This
// hourly check re-attempts within the same morning window; alreadySent/
// markSent make sendLivestreamReminder itself safe to call redundantly.
async function checkLivestreamReminderWindow(): Promise<void> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  if (weekday !== "Tue" || hour < 8 || hour > 10) return;
  await sendLivestreamReminder();
}

// Music Monday: a song's release_at passing is what makes it visible to
// members (the public /api/songs query already filters on it) — this just
// catches the moment that happens and fires the one-time "new song" push,
// gated by notified_at so it can run hourly without double-sending.
async function checkForNewlyReleasedSongs(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, title FROM songs WHERE release_at IS NOT NULL AND release_at <= now() AND notified_at IS NULL`
  );

  for (const row of rows) {
    try {
      await broadcastNotification({
        title: "🎵 New Music Monday Song!",
        body: `"${row.title}" just dropped on the WELL Collective Playlist.`,
        tag: "new-song",
        url: "/music",
      });
      await pool.query(`UPDATE songs SET notified_at = now() WHERE id = $1`, [row.id]);
    } catch (err) {
      console.error(`Failed to send new-song notification for song ${row.id}:`, err);
    }
  }
}

async function sendTrialWinbackEmails(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT email, name FROM members
     WHERE trial_ends_at < CURRENT_DATE
       AND trial_ends_at IS NOT NULL
       AND trial_winback_sent = FALSE`
  );

  if (rows.length === 0) return;

  console.log(`[BREVO] Sending win-back emails to ${rows.length} expired trial member(s)`);
  for (const row of rows) {
    try {
      await sendTrialExpiredEmail(row.email, row.name);
      await pool.query(
        "UPDATE members SET trial_winback_sent = TRUE WHERE email = $1",
        [row.email]
      );
      // Move contact from "App Free Trial" → "App Trial Completed" in Brevo.
      await moveTrialContactToCompleted(row.email, row.name);
    } catch (err) {
      console.error(`[BREVO] Win-back failed for ${row.email}:`, err);
    }
  }
}

async function sendMidTrialEmails(): Promise<void> {
  // All members (trial OR paid) who joined 3–4 days ago and haven't received the day-3 email.
  const { rows } = await pool.query(
    `SELECT email, name FROM members
     WHERE created_at >= now() - INTERVAL '4 days'
       AND created_at <  now() - INTERVAL '3 days'
       AND day3_email_sent = FALSE`
  );

  if (rows.length === 0) return;

  console.log(`[BREVO] Sending day-3 emails to ${rows.length} member(s)`);
  for (const row of rows) {
    try {
      await sendMidTrialEmail(row.email, row.name);
      await pool.query(
        "UPDATE members SET day3_email_sent = TRUE, trial_mid_email_sent = TRUE WHERE email = $1",
        [row.email]
      );
    } catch (err) {
      console.error(`[BREVO] Day-3 email failed for ${row.email}:`, err);
    }
  }
}

async function syncMembersToBrevoLists(): Promise<void> {
  // Active trial members → "App Free Trial"
  const { rows: activeRows } = await pool.query(
    `SELECT email, name, trial_ends_at::text AS trial_ends_at
     FROM members
     WHERE trial_ends_at IS NOT NULL AND trial_ends_at >= CURRENT_DATE`
  );
  for (const row of activeRows) {
    await addTrialContactToBrevo(row.email, row.name, row.trial_ends_at).catch(() => {});
  }

  // Expired trial members → move to "App Trial Completed" (removes from Free Trial list too)
  const { rows: expiredRows } = await pool.query(
    `SELECT email, name FROM members
     WHERE trial_ends_at IS NOT NULL AND trial_ends_at < CURRENT_DATE`
  );
  for (const row of expiredRows) {
    await moveTrialContactToCompleted(row.email, row.name).catch(() => {});
  }

  console.log(`[BREVO] Synced ${activeRows.length} active + ${expiredRows.length} expired trial members to lists`);
}

export async function sendDay3EmailBlast(): Promise<{ trial: number; full: number; total: number }> {
  // Trial members who haven't received it
  const { rows: trialRows } = await pool.query(
    `SELECT email, name FROM members
     WHERE day3_email_sent = FALSE
       AND trial_ends_at IS NOT NULL AND trial_ends_at >= CURRENT_DATE`
  );
  // Full (paid) members who haven't received it
  const { rows: fullRows } = await pool.query(
    `SELECT email, name FROM members
     WHERE day3_email_sent = FALSE
       AND (trial_ends_at IS NULL OR trial_ends_at < CURRENT_DATE)`
  );

  const all = [...trialRows, ...fullRows];
  if (all.length === 0) return { trial: 0, full: 0, total: 0 };

  console.log(`[BREVO] Day-3 blast: ${trialRows.length} trial + ${fullRows.length} full member(s)`);
  let trialSent = 0, fullSent = 0;

  for (const row of trialRows) {
    try {
      await sendMidTrialEmail(row.email, row.name);
      await pool.query(
        "UPDATE members SET day3_email_sent = TRUE, trial_mid_email_sent = TRUE WHERE email = $1",
        [row.email]
      );
      trialSent++;
    } catch (err) {
      console.error(`[BREVO] Day-3 blast (trial) failed for ${row.email}:`, err);
    }
  }

  for (const row of fullRows) {
    try {
      await sendMidTrialEmail(row.email, row.name);
      await pool.query(
        "UPDATE members SET day3_email_sent = TRUE WHERE email = $1",
        [row.email]
      );
      fullSent++;
    } catch (err) {
      console.error(`[BREVO] Day-3 blast (full) failed for ${row.email}:`, err);
    }
  }

  console.log(`[BREVO] Day-3 blast complete: ${trialSent} trial + ${fullSent} full sent`);
  return { trial: trialSent, full: fullSent, total: trialSent + fullSent };
}

async function sendMidTrialEmailBlast(): Promise<void> {
  await sendDay3EmailBlast();
}

async function crownDailyWinner(): Promise<void> {
  // Find the member with the most points in yesterday's day, in the member-facing timezone.
  const { rows } = await pool.query(`
    SELECT al.member_email, SUM(al.points)::int AS total
    FROM activity_logs al
    JOIN members m ON m.email = al.member_email
    WHERE al.created_at >= ${SQL_DAY_START} - INTERVAL '1 day'
      AND al.created_at <  ${SQL_DAY_START}
      AND m.show_on_leaderboard = TRUE
    GROUP BY al.member_email
    ORDER BY total DESC
    LIMIT 1
  `);
  if (rows.length === 0) return;

  const winDate = addDays(todayInTimezone(), -1);

  const { rowCount } = await pool.query(
    `INSERT INTO well_cup_wins (member_email, win_date, total_points)
     VALUES ($1, $2, $3)
     ON CONFLICT (win_date) DO NOTHING`,
    [rows[0].member_email, winDate, rows[0].total]
  );
  console.log(`[WELL CUP] ${winDate} winner: ${rows[0].member_email} (${rows[0].total} pts)`);

  // Notify the winner — only on the first insert (not if already recorded)
  if (rowCount && rowCount > 0) {
    await sendNotificationToUser(rows[0].member_email, {
      title: "🏆 You won the WELL Cup today!",
      body: `${rows[0].total.toLocaleString()} points — you led the entire leaderboard. Open the app to share your win!`,
      tag: "well-cup-win",
    }).catch((err) => console.error("[WELL CUP] Push to winner failed:", err));
  }
}

async function crownMonthlyWinner(): Promise<void> {
  // Runs on the last day of each month — find the member with the most points this month.
  const { rows } = await pool.query(`
    SELECT al.member_email, m.name, SUM(al.points)::int AS total
    FROM activity_logs al
    JOIN members m ON m.email = al.member_email
    WHERE al.created_at >= ${SQL_MONTH_START}
      AND m.show_on_leaderboard = TRUE
    GROUP BY al.member_email, m.name
    ORDER BY total DESC
    LIMIT 1
  `);
  if (rows.length === 0) return;

  const monthName = new Date().toLocaleString("default", { month: "long", year: "numeric" });
  console.log(`[WELL CUP] ${monthName} monthly leader: ${rows[0].member_email} (${rows[0].total} pts)`);

  await sendNotificationToUser(rows[0].member_email, {
    title: `🏆 You're the ${monthName} WELL Cup Leader!`,
    body: `${rows[0].total.toLocaleString()} points this month — you've earned a free month of WELL Collective. We'll be in touch!`,
    tag: "well-cup-monthly-win",
  }).catch((err) => console.error("[WELL CUP] Monthly push failed:", err));
}

async function sendPersonalizedWellChecks(): Promise<void> {
  const date = todayInTimezone();
  if (await alreadySent(date, "wellCheck")) return;

  // Fetch every member's point total for today (member-facing timezone) in one query.
  const { rows: pointRows } = await pool.query(`
    SELECT m.email, m.name, COALESCE(SUM(al.points), 0)::int AS today_pts
    FROM members m
    LEFT JOIN activity_logs al
      ON al.member_email = m.email
      AND al.created_at >= ${SQL_DAY_START}
    WHERE m.membership_status = 'active'
       OR m.trial_ends_at >= CURRENT_DATE
    GROUP BY m.email, m.name
  `);

  // Also grab which activity types each member completed today (for the challenge preview).
  const { rows: activityRows } = await pool.query(`
    SELECT DISTINCT member_email, activity_type
    FROM activity_logs
    WHERE created_at >= ${SQL_DAY_START}
  `);
  const doneByEmail = new Map<string, Set<string>>();
  for (const r of activityRows) {
    if (!doneByEmail.has(r.member_email)) doneByEmail.set(r.member_email, new Set());
    doneByEmail.get(r.member_email)!.add(r.activity_type);
  }

  const CHALLENGE_HINTS: { type: string; label: string }[] = [
    { type: "resistance_training", label: "a strength session" },
    { type: "breathwork",          label: "10 min of breathwork" },
    { type: "stretching",          label: "your stretching routine" },
    { type: "class_watch",         label: "a wellness class" },
    { type: "meal_log",            label: "logging your meals" },
    { type: "well_activity",       label: "the daily WELL activity" },
  ];

  let sent = 0;
  for (const row of pointRows) {
    try {
      const pts: number = row.today_pts;
      const done = doneByEmail.get(row.email) ?? new Set();

      // Pick the first missing activity as the challenge hint.
      const missing = CHALLENGE_HINTS.find((c) => !done.has(c.type));
      const challengeHint = missing ? ` Tomorrow: try ${missing.label}!` : " Amazing day — all activities complete!";

      const body = pts > 0
        ? `You earned ${pts} pts today! 🌟${challengeHint} Tap to see your full summary.`
        : `The day isn't over yet! Log an activity and earn your first points.${challengeHint}`;

      await sendNotificationToUser(row.email, {
        title: "Your Daily WELL Check ✨",
        body,
        tag: "well-check",
        url: "/well-check",
      });
      sent++;
    } catch (err) {
      console.error(`[WELL CHECK] Failed to notify ${row.email}:`, err);
    }
  }
  console.log(`[WELL CHECK] Sent personalized notifications to ${sent} members`);
  await markSent(date, "wellCheck");
}

export function startScheduler(): void {
  // AI content generation (motivation boost, recipe, nutrition tip): every day at 5:30am,
  // ahead of the 7am sends below so generated content is ready in time.
  cron.schedule("30 5 * * *", () => {
    generateAIContent().catch((err) => console.error("AI content generation failed:", err));
  }, { timezone: TIMEZONE });

  // Weekly theme: every Monday at 7:00am
  cron.schedule("0 7 * * 1", () => {
    sendWeeklyTheme().catch((err) => console.error("Weekly theme send failed:", err));
  }, { timezone: TIMEZONE });

  // Daily inspiration: every day at 7:00am
  cron.schedule("0 7 * * *", () => {
    sendDailyInspiration().catch((err) => console.error("Daily inspiration send failed:", err));
  }, { timezone: TIMEZONE });

  // Livestream reminder: every Tuesday at 8:00am (1 hour before 9am livestream)
  cron.schedule("0 8 * * 2", () => {
    sendLivestreamReminder().catch((err) => console.error("Livestream reminder send failed:", err));
  }, { timezone: TIMEZONE });

  // Check for new blog posts: every hour on the hour
  cron.schedule("0 * * * *", () => {
    checkForNewBlogPosts().catch((err) => console.error("Blog post check failed:", err));
  });

  // Check for new videos: every 30 minutes (more frequent since you upload classes often)
  cron.schedule("*/30 * * * *", () => {
    checkForNewVideos().catch((err) => console.error("Video check failed:", err));
  });

  // Check for new live events on lorettabates.com: every hour on the hour
  cron.schedule("0 * * * *", () => {
    checkForNewLiveEvents().catch((err) => console.error("Live event check failed:", err));
  });

  // Music Monday: every hour on the hour — catches whenever a queued song's
  // release_at passes and sends the one-time "new song" push for it.
  cron.schedule("0 * * * *", () => {
    checkForNewlyReleasedSongs().catch((err) => console.error("New song check failed:", err));
  });

  // Safety net for the exact-time Tuesday 8am livestream reminder above —
  // re-checks hourly through mid-morning in case the exact tick was missed.
  cron.schedule("0 * * * *", () => {
    checkLivestreamReminderWindow().catch((err) => console.error("Livestream reminder window check failed:", err));
  });

  // DAY-3 MID-TRIAL EMAIL: 9am ET, same schedule as win-back.
  cron.schedule("0 9 * * *", () => {
    sendMidTrialEmails().catch((err) => console.error("Mid-trial emails failed:", err));
  }, { timezone: TIMEZONE });

  // BREVO LIST SYNC: every morning at 6am ET — keeps "App Free Trial" and
  // "App Trial Completed" lists current so Loretta can run campaigns against them.
  cron.schedule("0 6 * * *", () => {
    syncMembersToBrevoLists().catch((err) => console.error("Brevo list sync failed:", err));
  }, { timezone: TIMEZONE });

  // Post-trial win-back: every day at 9am ET, finds any members whose trial
  // ended yesterday (or earlier) and haven't received the email yet. The
  // trial_winback_sent flag is the idempotency guard — safe to restart/redeploy.
  cron.schedule("0 9 * * *", () => {
    sendTrialWinbackEmails().catch((err) => console.error("Trial win-back emails failed:", err));
  }, { timezone: TIMEZONE });

  // WELL CHECK: every evening at 9pm ET, personalized per-member.
  cron.schedule("0 21 * * *", () => {
    sendPersonalizedWellChecks().catch((err) => console.error("Well Check notifications failed:", err));
  }, { timezone: TIMEZONE });

  // WELL CUP: midnight ET — crown yesterday's top scorer.
  // Runs at 00:00 America/New_York so the member-facing day has fully closed before we tally.
  cron.schedule("0 0 * * *", () => {
    crownDailyWinner().catch((err) => console.error("Crown daily winner failed:", err));
  }, { timezone: TIMEZONE });

  // WELL CUP: last day of each month at 11:45 PM ET — notify monthly leader.
  cron.schedule("45 23 28-31 * *", async () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    // Only run on the actual last day of the month
    if (tomorrow.getMonth() !== now.getMonth()) {
      crownMonthlyWinner().catch((err) => console.error("Crown monthly winner failed:", err));
    }
  }, { timezone: TIMEZONE });

  // WELL CUP: award event_attend points for events that passed yesterday.
  cron.schedule("5 0 * * *", async () => {
    try {
      const yesterday = addDays(todayInTimezone(), -1);
      const { rows: rsvpRows } = await pool.query<{ member_email: string }>(
        "SELECT DISTINCT member_email FROM event_rsvps WHERE event_id IN (SELECT id FROM events WHERE date = $1)",
        [yesterday]
      );
      for (const row of rsvpRows) {
        await awardPoints(row.member_email, "event_attend");
      }
      if (rsvpRows.length > 0) {
        console.log(`Awarded event_attend points to ${rsvpRows.length} members for ${yesterday} events`);
      }
    } catch (err) {
      console.error("Event attend points error:", err);
    }
  }, { timezone: TIMEZONE });

  // SCHEDULED NOTIFICATIONS: check every minute for due notifications.
  cron.schedule("* * * * *", async () => {
    try {
      const { rows } = await pool.query<{ title: string; body: string }>(
        "UPDATE scheduled_notifications SET sent = TRUE WHERE send_at <= now() AND sent = FALSE RETURNING title, body"
      );
      for (const row of rows) {
        await broadcastNotification({ title: row.title, body: row.body, tag: "scheduled" });
      }
    } catch (err) {
      console.error("Scheduled notification dispatch error:", err);
    }
  });

  // Run immediately on startup: create/populate both Brevo lists.
  syncMembersToBrevoLists().catch((err) => console.error("Brevo startup sync failed:", err));
  // Immediately send mid-trial email to any existing trial members who haven't received it.
  sendMidTrialEmailBlast().catch((err) => console.error("Mid-trial startup blast failed:", err));

  console.log(`Scheduler started (timezone: ${TIMEZONE})`);
}
