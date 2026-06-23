import { Router } from "express";
import { pool } from "../db";

const router = Router();

// Mirrors the client-side deriveMemberId() in AppContext.tsx exactly — both
// must produce the same id for a given email for DMs/likes/RSVPs to line up.
function deriveMemberId(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return `m_${Math.abs(hash).toString(36)}`;
}

router.post("/members/sync", async (req, res) => {
  const { email, name, avatar, birthday, showBirthdayOnCalendar } = req.body as {
    email?: string;
    name?: string;
    avatar?: string;
    birthday?: string;
    showBirthdayOnCalendar?: boolean;
  };

  if (!email || !name) {
    return res.status(400).json({ error: "email and name required" });
  }

  try {
    await pool.query(
      `INSERT INTO members (email, name, avatar, birthday, show_birthday_on_calendar, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (email) DO UPDATE SET
         name = $2, avatar = $3, birthday = $4, show_birthday_on_calendar = $5, updated_at = now()`,
      [email.toLowerCase(), name, avatar || null, birthday || null, !!showBirthdayOnCalendar]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Sync member error:", err);
    res.status(500).json({ error: "Failed to sync member" });
  }
});

router.get("/members", async (req, res) => {
  const excludeEmail = (req.query.excludeEmail as string | undefined)?.toLowerCase();

  try {
    const { rows } = await pool.query(
      "SELECT email, name, avatar FROM members WHERE email != $1 ORDER BY name ASC",
      [excludeEmail || ""]
    );
    res.json({
      members: rows.map((row) => ({
        id: deriveMemberId(row.email),
        name: row.name,
        avatar: row.avatar ?? undefined,
      })),
    });
  } catch (err) {
    console.error("Fetch members error:", err);
    res.status(500).json({ error: "Failed to fetch members" });
  }
});

router.get("/members/birthdays", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT email, name, birthday FROM members WHERE show_birthday_on_calendar = true AND birthday IS NOT NULL"
    );
    res.json({
      birthdays: rows.map((row) => ({
        id: deriveMemberId(row.email),
        name: row.name,
        birthday: row.birthday,
      })),
    });
  } catch (err) {
    console.error("Fetch birthdays error:", err);
    res.status(500).json({ error: "Failed to fetch birthdays" });
  }
});

export default router;
