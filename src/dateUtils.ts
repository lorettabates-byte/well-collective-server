// Competition day boundary: 05:00 UTC. This gives the best global spread:
//   US Pacific  → 10 PM local  (activities done for the day)
//   US East     →  1 AM local  (effectively overnight)
//   Netherlands →  7 AM local  (fresh start of their day)
//   Asia/Pacific → midday local (no great option exists for all zones)
//
// The "Resets in X" countdown already accounts for this automatically because
// it's computed client-side as (resetAt UTC) - Date.now(), which is always
// expressed in the viewer's local wall-clock time.
const DAY_OFFSET_HOURS = 5;

// Cron scheduling timezone: notifications fire at clock times meaningful to the
// primary audience (US Eastern). Kept separate from day-boundary logic so
// changing the reset time doesn't shift push notification times.
export const CRON_TIMEZONE = process.env.SCHEDULE_TIMEZONE || "America/New_York";

// TIMEZONE is kept as an alias used by existing imports elsewhere in the
// codebase; point it at UTC since all the SQL expressions below compute their
// own offset independently.
export const TIMEZONE = "UTC";

export function todayInTimezone(): string {
  // Return the current competition date (YYYY-MM-DD) in the 5-hour-offset "day".
  const offsetDate = new Date(Date.now() - DAY_OFFSET_HOURS * 60 * 60 * 1000);
  return offsetDate.toISOString().slice(0, 10);
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Reusable SQL fragments. All use the same 5-hour offset so every query
// agrees on what "today", "this month", and "this year" mean.
export const SQL_DAY_START   = `(date_trunc('day', now() - INTERVAL '${DAY_OFFSET_HOURS} hours') + INTERVAL '${DAY_OFFSET_HOURS} hours')`;
export const SQL_MONTH_START = `(date_trunc('month', now() - INTERVAL '${DAY_OFFSET_HOURS} hours') + INTERVAL '${DAY_OFFSET_HOURS} hours')`;
export const SQL_YEAR_START  = `(date_trunc('year', now() - INTERVAL '${DAY_OFFSET_HOURS} hours') + INTERVAL '${DAY_OFFSET_HOURS} hours')`;

export function sqlSameDay(column: string): string {
  return `(${column} - INTERVAL '${DAY_OFFSET_HOURS} hours')::date = (now() - INTERVAL '${DAY_OFFSET_HOURS} hours')::date`;
}
