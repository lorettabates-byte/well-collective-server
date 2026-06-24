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
  const { email, name, avatar, bio, birthday, showBirthdayOnCalendar } = req.body as {
    email?: string;
    name?: string;
    avatar?: string;
    bio?: string;
    birthday?: string;
    showBirthdayOnCalendar?: boolean;
  };

  if (!email || !name) {
    return res.status(400).json({ error: "email and name required" });
  }

  try {
    // Use COALESCE so a blank/missing avatar, bio, or birthday from the
    // client (e.g. a false-positive "new member" reset on the client, or a
    // stale/wiped local profile) can never overwrite a value already saved
    // for this member — it can only fill in a field that's still empty.
    await pool.query(
      `INSERT INTO members (email, name, avatar, bio, birthday, show_birthday_on_calendar, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (email) DO UPDATE SET
         name = $2,
         avatar = COALESCE($3, members.avatar),
         bio = COALESCE($4, members.bio),
         birthday = COALESCE($5, members.birthday),
         show_birthday_on_calendar = $6,
         updated_at = now()`,
      [email.toLowerCase(), name, avatar || null, bio || null, birthday || null, !!showBirthdayOnCalendar]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Sync member error:", err);
    res.status(500).json({ error: "Failed to sync member" });
  }
});

// Restore a member's own saved profile from the server. Used by the client
// to recover avatar/bio/birthday after local storage gets wiped (e.g. by
// Safari's tracking-prevention purge, or a fresh re-login) — without this,
// a wipe would permanently strand the member with a blank profile since
// the client only ever pushes local data to the server, never pulls it back.
router.get("/members/me", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();

  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT name, avatar, bio, birthday, show_birthday_on_calendar FROM members WHERE email = $1",
      [email]
    );

    if (rows.length === 0) {
      return res.json({ member: null });
    }

    const row = rows[0];
    res.json({
      member: {
        name: row.name,
        avatar: row.avatar ?? undefined,
        bio: row.bio ?? undefined,
        birthday: row.birthday ?? undefined,
        showBirthdayOnCalendar: row.show_birthday_on_calendar,
      },
    });
  } catch (err) {
    console.error("Fetch member error:", err);
    res.status(500).json({ error: "Failed to fetch member" });
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
