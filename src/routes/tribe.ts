import { Router } from "express";
import { pool } from "../db";
import { sendNotificationToUser } from "../push";

const router = Router();

// Mirrors deriveMemberId() in members.ts/messages.ts/AppContext.tsx — tribe
// members are referenced by id on the client, never raw email.
function deriveMemberId(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return `m_${Math.abs(hash).toString(36)}`;
}

async function findEmailByMemberId(memberId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT email FROM members");
  for (const row of rows) {
    if (deriveMemberId(row.email) === memberId) return row.email;
  }
  return null;
}

// Get a member's WELL Tribe
router.get("/tribe", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT m.email, m.name, m.avatar
       FROM tribe_members t
       JOIN members m ON m.email = t.member_email
       WHERE t.owner_email = $1
       ORDER BY t.created_at DESC`,
      [email]
    );

    res.json({
      tribe: rows.map((row) => ({
        id: deriveMemberId(row.email),
        name: row.name,
        avatar: row.avatar ?? undefined,
      })),
    });
  } catch (err) {
    console.error("Fetch WELL Tribe error:", err);
    res.status(500).json({ error: "Failed to fetch WELL Tribe" });
  }
});

// Add a member to the caller's WELL Tribe
router.post("/tribe", async (req, res) => {
  const { email, memberId } = req.body as { email?: string; memberId?: string };
  if (!email || !memberId) {
    return res.status(400).json({ error: "email and memberId required" });
  }

  const ownerEmail = email.toLowerCase();

  try {
    const targetEmail = await findEmailByMemberId(memberId);
    if (!targetEmail) {
      return res.status(404).json({ error: "Member not found" });
    }
    if (targetEmail.toLowerCase() === ownerEmail) {
      return res.status(400).json({ error: "Cannot add yourself to your own WELL Tribe" });
    }

    await pool.query(
      `INSERT INTO tribe_members (owner_email, member_email) VALUES ($1, $2)
       ON CONFLICT (owner_email, member_email) DO NOTHING`,
      [ownerEmail, targetEmail.toLowerCase()]
    );

    const { rows: ownerRows } = await pool.query("SELECT name FROM members WHERE email = $1", [ownerEmail]);
    const ownerName = ownerRows[0]?.name || "Someone";

    sendNotificationToUser(targetEmail, {
      title: "WELL Tribe",
      body: `${ownerName} added you to their WELL Tribe!`,
      tag: "tribe",
      url: "/tribe",
    }).catch((err) => console.error("Failed to send WELL Tribe notification:", err));

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Add to WELL Tribe error:", err);
    res.status(500).json({ error: "Failed to add to WELL Tribe" });
  }
});

// Remove a member from the caller's WELL Tribe
router.delete("/tribe/:memberId", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  try {
    const targetEmail = await findEmailByMemberId(req.params.memberId);
    if (!targetEmail) {
      return res.status(404).json({ error: "Member not found" });
    }

    await pool.query("DELETE FROM tribe_members WHERE owner_email = $1 AND member_email = $2", [
      email,
      targetEmail.toLowerCase(),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error("Remove from WELL Tribe error:", err);
    res.status(500).json({ error: "Failed to remove from WELL Tribe" });
  }
});

export default router;
