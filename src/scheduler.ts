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
import { broadcastNotification } from "./push";
import { computeNutritionFromIngredients, isUsdaConfigured } from "./usda";
import { sendTrialExpiredEmail } from "./brevo";

const TIMEZONE = process.env.SCHEDULE_TIMEZONE || "America/New_York";

function todayInTimezone(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date()); // en-CA gives YYYY-MM-DD
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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
    } catch (err) {
      console.error(`[BREVO] Win-back failed for ${row.email}:`, err);
    }
  }
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

  // Post-trial win-back: every day at 9am ET, finds any members whose trial
  // ended yesterday (or earlier) and haven't received the email yet. The
  // trial_winback_sent flag is the idempotency guard — safe to restart/redeploy.
  cron.schedule("0 9 * * *", () => {
    sendTrialWinbackEmails().catch((err) => console.error("Trial win-back emails failed:", err));
  }, { timezone: TIMEZONE });

  console.log(`Scheduler started (timezone: ${TIMEZONE})`);
}
