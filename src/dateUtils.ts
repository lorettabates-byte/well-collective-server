export const TIMEZONE = process.env.SCHEDULE_TIMEZONE || "America/New_York";

export function todayInTimezone(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date()); // en-CA gives YYYY-MM-DD
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Reusable SQL fragments — filter timestamptz columns by the configured
// timezone's calendar day/month/year rather than the UTC calendar boundary,
// so "today" in queries matches "today" as members actually experience it.
export const SQL_DAY_START = `date_trunc('day', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'`;
export const SQL_MONTH_START = `date_trunc('month', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'`;
export const SQL_YEAR_START = `date_trunc('year', now() AT TIME ZONE '${TIMEZONE}') AT TIME ZONE '${TIMEZONE}'`;

export function sqlSameDay(column: string): string {
  return `(${column} AT TIME ZONE '${TIMEZONE}')::date = (now() AT TIME ZONE '${TIMEZONE}')::date`;
}
