import cron from "node-cron";
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
  if (await alreadySent(date, "weeklyTheme")) return;

  const { rows } = await pool.query("SELECT weekly_theme FROM content_schedule WHERE date = $1", [date]);
  const theme = rows[0]?.weekly_theme as { title: string; body: string } | undefined;
  if (!theme) return;

  await broadcastNotification({
    title: `This Week's Theme: ${theme.title}`,
    body: theme.body,
    tag: "weekly-theme",
    url: "/inspirations",
  });
  await markSent(date, "weeklyTheme");
}

async function sendDailyInspiration(): Promise<void> {
  const date = todayInTimezone();
  if (await alreadySent(date, "dailyInspiration")) return;

  const { rows } = await pool.query("SELECT daily_inspiration FROM content_schedule WHERE date = $1", [date]);
  const inspiration = rows[0]?.daily_inspiration as { title: string; body: string } | undefined;
  if (!inspiration) return;

  await broadcastNotification({
    title: inspiration.title,
    body: inspiration.body,
    tag: "daily-inspiration",
    url: "/inspirations",
  });
  await markSent(date, "dailyInspiration");
}

export function startScheduler(): void {
  // Weekly theme: every Monday at 7:00am
  cron.schedule("0 7 * * 1", () => {
    sendWeeklyTheme().catch((err) => console.error("Weekly theme send failed:", err));
  }, { timezone: TIMEZONE });

  // Daily inspiration: every day at 7:00am
  cron.schedule("0 7 * * *", () => {
    sendDailyInspiration().catch((err) => console.error("Daily inspiration send failed:", err));
  }, { timezone: TIMEZONE });

  console.log(`Scheduler started (timezone: ${TIMEZONE})`);
}
