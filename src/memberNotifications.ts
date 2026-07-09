import { pool } from "./db";

export interface MemberNotificationInput {
  memberEmail: string;
  type?: string;
  title: string;
  body: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export async function createMemberNotification(input: MemberNotificationInput): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO member_notifications (member_email, type, title, body, link, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.memberEmail.toLowerCase(),
      input.type ?? "general",
      input.title,
      input.body,
      input.link ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
  return Number(rows[0].id);
}
