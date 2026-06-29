import { Router } from "express";
import { pool } from "../db";
import { deriveMemberId } from "../memberId";

const router = Router();

interface ReactionRow {
  inspiration_id: string;
  reaction: string;
  member_email: string;
}

// Batch lookup — the client always has several inspirations on screen at
// once (today's, this week's, recent notes), so one request for all of
// them avoids an endpoint-per-card waterfall.
router.get("/inspirations/reactions", async (req, res) => {
  const idsParam = req.query.ids as string | undefined;
  if (!idsParam) return res.json({ reactions: {} });
  const ids = idsParam.split(",").filter(Boolean);
  if (ids.length === 0) return res.json({ reactions: {} });

  try {
    const { rows } = await pool.query<ReactionRow>(
      `SELECT inspiration_id, reaction, member_email FROM inspiration_reactions WHERE inspiration_id = ANY($1)`,
      [ids]
    );

    const reactions: Record<string, { likes: string[]; savedBy: string[] }> = {};
    for (const id of ids) reactions[id] = { likes: [], savedBy: [] };

    for (const row of rows) {
      const memberId = deriveMemberId(row.member_email);
      const bucket = row.reaction === "like" ? reactions[row.inspiration_id].likes : reactions[row.inspiration_id].savedBy;
      bucket.push(memberId);
    }

    res.json({ reactions });
  } catch (err) {
    console.error("Fetch inspiration reactions error:", err);
    res.status(500).json({ error: "Failed to fetch reactions" });
  }
});

router.post("/inspirations/:id/react", async (req, res) => {
  const { email, reaction, active } = req.body as {
    email?: string;
    reaction?: "like" | "save";
    active?: boolean;
  };
  if (!email || (reaction !== "like" && reaction !== "save") || typeof active !== "boolean") {
    return res.status(400).json({ error: "email, reaction ('like'|'save'), and active are required" });
  }

  try {
    if (active) {
      await pool.query(
        `INSERT INTO inspiration_reactions (inspiration_id, member_email, reaction)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.params.id, email.toLowerCase(), reaction]
      );
    } else {
      await pool.query(
        `DELETE FROM inspiration_reactions WHERE inspiration_id = $1 AND member_email = $2 AND reaction = $3`,
        [req.params.id, email.toLowerCase(), reaction]
      );
    }

    const { rows } = await pool.query<ReactionRow>(
      `SELECT inspiration_id, reaction, member_email FROM inspiration_reactions WHERE inspiration_id = $1`,
      [req.params.id]
    );
    const likes = rows.filter((r) => r.reaction === "like").map((r) => deriveMemberId(r.member_email));
    const savedBy = rows.filter((r) => r.reaction === "save").map((r) => deriveMemberId(r.member_email));

    res.json({ likes, savedBy });
  } catch (err) {
    console.error("Set inspiration reaction error:", err);
    res.status(500).json({ error: "Failed to set reaction" });
  }
});

export default router;
