import { pool } from "../db";

// Mirrors the client-side deriveMemberId() in AppContext.tsx exactly — both
// must produce the same id for a given email for DMs/likes/RSVPs to line up.
export function deriveMemberId(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return `m_${Math.abs(hash).toString(36)}`;
}

// Member ids in URLs (DMs, forum authorship, etc.) are always the derived
// hash, never a raw email, so any route taking a memberId has to reverse it
// back to an email by scanning the directory.
export async function findEmailByMemberId(memberId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT email FROM members");
  for (const row of rows) {
    if (deriveMemberId(row.email) === memberId) return row.email;
  }
  return null;
}
