import cron from "node-cron";
import {
  generateDailyInspiration,
  generateMotivationBoost,
  generateNutritionTip,
  generateRecipe,
  generateWeeklyTheme,
  isAnthropicConfigured,
} from "./anthropic";
import { pool } from "./db";
import { broadcastNotification } from "./push";

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

  const date = todayInTimezone();
  console.log(`[SCHEDULER] AI content generation check for ${date}`);

  const { rows } = await pool.query(
    "SELECT daily_inspiration, recipe, motivation_boost, nutrition_tip FROM content_schedule WHERE date = $1",
    [date]
  );
  const row = rows[0] as
    | { daily_inspiration?: { title?: string }; recipe?: unknown; motivation_boost?: unknown; nutrition_tip?: string }
    | undefined;

  let weeklyThemeTitle = await findCurrentWeeklyThemeTitle(date);

  if (!weeklyThemeTitle) {
    try {
      const theme = await generateWeeklyTheme();
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
      const inspiration = await generateDailyInspiration(weeklyThemeTitle);
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
      const recipe = await generateRecipe(weeklyThemeTitle);
      await pool.query(
        `INSERT INTO content_schedule (date, recipe) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET recipe = COALESCE(content_schedule.recipe, $2)`,
        [date, JSON.stringify(recipe)]
      );
      console.log(`[SCHEDULER] Generated AI recipe: "${recipe.name}"`);
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

  await broadcastNotification({
    title: "WELL Collective Live Cardio Class",
    body: "Join us in 1 hour for a fun live cardio class! Get ready to move and connect with the community. 💪",
    tag: "livestream-reminder",
    url: "/videos",
  });
  await markSent(date, "livestreamReminder");
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

  console.log(`Scheduler started (timezone: ${TIMEZONE})`);
}
