import { pool } from "./db";
import { isExcludedAccount } from "./paidMembers";
import { sendNotificationToUser } from "./push";
import { deriveMemberId } from "./utils/memberUtils";

// Loretta wants every member in her WELL Tribe so she can see their birthdays,
// streaks and moods (2026-10-16). Each day, members who joined at least a day
// ago and are not in her Tribe yet are added. Only recent joiners get a push;
// the first run quietly adds everyone who was already here.
const LORETTA = "loretta@lorettabates.com";

export async function addMembersToLorettasTribe(): Promise<{ added: number; notified: number }> {
  const { rows } = await pool.query<{ email: string; name: string | null; recent: boolean }>(
    `SELECT m.email, m.name, (m.created_at > now() - interval '4 days') AS recent
       FROM members m
      WHERE lower(m.email) <> $1
        AND m.created_at < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM tribe_members t WHERE t.owner_email = $1 AND t.member_email = m.email)`,
    [LORETTA]
  );
  const lorettaId = deriveMemberId(LORETTA);
  let added = 0;
  let notified = 0;
  for (const r of rows) {
    if (!r.email.includes("@") || isExcludedAccount(r.email, r.name)) continue;
    // Respect a member who has blocked Loretta.
    const { rows: blocked } = await pool.query(
      "SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 LIMIT 1",
      [deriveMemberId(r.email.toLowerCase()), lorettaId]
    );
    if (blocked.length) continue;
    const ins = await pool.query(
      `INSERT INTO tribe_members (owner_email, member_email) VALUES ($1, $2)
       ON CONFLICT (owner_email, member_email) DO NOTHING RETURNING member_email`,
      [LORETTA, r.email]
    );
    if (!ins.rows.length) continue;
    added++;
    if (r.recent) {
      await sendNotificationToUser(r.email, {
        title: "WELL Tribe",
        body: "Loretta added you to her WELL Tribe! So happy you are here.",
        tag: "tribe",
        url: "/tribe",
      }).catch(() => {});
      notified++;
    }
  }
  console.log(`[LORETTA TRIBE] added ${added}, notified ${notified}`);
  return { added, notified };
}
