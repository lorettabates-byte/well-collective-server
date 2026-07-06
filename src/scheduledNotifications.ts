import cron from "node-cron";
import { pool } from "./db";
import { broadcastNotification } from "./push";

// Runs every hour to send notifications at 7am, 3pm, 9pm in each user's local timezone
export function scheduleTimezoneNotifications() {
  cron.schedule("0 * * * *", async () => {
    try {
      console.log("[SCHEDULED] Hourly timezone notification check");

      // Get all members with notification schedule enabled
      const { rows: members } = await pool.query<{
        email: string;
        timezone: string;
        notification_schedule: { send7am?: boolean; send3pm?: boolean; send9pm?: boolean } | null;
      }>(
        `SELECT email, timezone, notification_schedule
         FROM members
         WHERE notification_schedule IS NOT NULL
         AND (notification_schedule->>'send7am' = 'true'
           OR notification_schedule->>'send3pm' = 'true'
           OR notification_schedule->>'send9pm' = 'true')`
      );

      console.log(`[SCHEDULED] Found ${members.length} members with timezone notifications enabled`);

      for (const member of members) {
        const schedule = member.notification_schedule || {};
        const timezone = member.timezone || "America/New_York";

        // Get current time in user's timezone
        const now = new Date();
        const userTimeString = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(now);

        const [hour, minute] = userTimeString.split(":").map(Number);

        // Check if it's 7am, 3pm, or 9pm in the user's timezone (and within 1 minute window to avoid duplicates)
        const shouldSend7am = schedule.send7am && hour === 7 && minute < 1;
        const shouldSend3pm = schedule.send3pm && hour === 15 && minute < 1;
        const shouldSend9pm = schedule.send9pm && hour === 21 && minute < 1;

        if (shouldSend7am || shouldSend3pm || shouldSend9pm) {
          let title = "Good morning!";
          let body = "Start your day with intention";

          if (shouldSend3pm) {
            title = "Afternoon check-in";
            body = "How are you feeling? Take a moment for yourself";
          } else if (shouldSend9pm) {
            title = "Evening reflection";
            body = "Wind down and reflect on your day";
          }

          console.log(`[SCHEDULED] Sending ${title} to ${member.email} at ${hour}:${String(minute).padStart(2, "0")}`);

          await broadcastNotification({
            title,
            body,
            tag: "scheduled-notification",
            url: "/",
          }).catch((err) => console.error(`Failed to send scheduled notification to ${member.email}:`, err));
        }
      }
    } catch (err) {
      console.error("[SCHEDULED] Timezone notification error:", err);
    }
  });
}
