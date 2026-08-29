import { Router } from "express";
import { pool } from "../db";
import { findEmailByMemberId, deriveMemberId } from "../utils/memberUtils";
import { sendNotificationToUser } from "../push";
import { createMemberNotification } from "../memberNotifications";
import { awardPoints } from "./points";

const router = Router();

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_challenges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      challenger_email TEXT NOT NULL,
      opponent_email TEXT NOT NULL,
      opponent_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      game_date TEXT NOT NULL,
      challenger_score INT NOT NULL DEFAULT 0,
      opponent_score INT,
      status TEXT NOT NULL DEFAULT 'pending',
      winner_email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
    );
    CREATE INDEX IF NOT EXISTS idx_gc_challenger ON game_challenges(challenger_email);
    CREATE INDEX IF NOT EXISTS idx_gc_opponent_email ON game_challenges(opponent_email);
  `);
}
ensureTable().catch(console.error);

function gameLabel(gameId: string) {
  const names: Record<string, string> = {
    wordwell: "WordWell", calmfocus: "Calm Focus", gratitude: "Gratitude Match",
    mindgarden: "Mind Garden", anagram: "Anagram", wordhunt: "Word Hunt",
  };
  return names[gameId] ?? (gameId.charAt(0).toUpperCase() + gameId.slice(1));
}

// POST /api/game-challenges — challenger has won; issue a challenge to an opponent
router.post("/game-challenges", async (req, res) => {
  const { email, opponentId, gameId, score } = req.body as {
    email?: string;
    opponentId?: string;
    gameId?: string;
    score?: number;
  };
  if (!email || !opponentId || !gameId || score == null) {
    return res.status(400).json({ error: "email, opponentId, gameId, and score required" });
  }
  const challengerEmail = email.toLowerCase();
  const gameDate = new Date().toISOString().slice(0, 10);

  try {
    if (deriveMemberId(challengerEmail) === opponentId) {
      return res.status(400).json({ error: "Cannot challenge yourself" });
    }

    const opponentEmail = await findEmailByMemberId(opponentId);
    if (!opponentEmail) return res.status(404).json({ error: "Opponent not found" });

    // Prevent duplicate challenge for same game/date/pair
    const dup = await pool.query(
      `SELECT id FROM game_challenges
       WHERE challenger_email = $1 AND opponent_email = $2 AND game_id = $3 AND game_date = $4
         AND status = 'pending'`,
      [challengerEmail, opponentEmail, gameId, gameDate]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: "Challenge already sent today", challengeId: dup.rows[0].id });
    }

    const { rows } = await pool.query(
      `INSERT INTO game_challenges
         (challenger_email, opponent_email, opponent_id, game_id, game_date, challenger_score)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [challengerEmail, opponentEmail, opponentId, gameId, gameDate, score]
    );
    const challengeId = rows[0].id as string;

    const nameRow = await pool.query("SELECT name FROM members WHERE email = $1", [challengerEmail]);
    const challengerName = nameRow.rows[0]?.name ?? "Someone";
    const label = gameLabel(gameId);

    await createMemberNotification({
      memberEmail: opponentEmail,
      type: "tribe",
      title: `${challengerName} played ${label} today`,
      body: `They shared their score with you. Give it a try and see how you do!`,
      link: `/games?challenge=${challengeId}`,
      metadata: { challengeId, gameId, challengerScore: score },
    });

    await sendNotificationToUser(opponentEmail, {
      title: `${challengerName} played ${label}!`,
      body: `They shared their score. Open the app to play and compare.`,
      tag: "game-challenge",
      url: `/games?challenge=${challengeId}`,
    });

    res.status(201).json({ ok: true, challengeId });
  } catch (err) {
    console.error("Create game challenge error:", err);
    res.status(500).json({ error: "Failed to create challenge" });
  }
});

// GET /api/game-challenges?email=... — fetch incoming + outgoing challenges
router.get("/game-challenges", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rows } = await pool.query(
      `SELECT gc.*,
              cm.name AS challenger_name, cm.avatar AS challenger_avatar,
              om.name AS opponent_name, om.avatar AS opponent_avatar
       FROM game_challenges gc
       JOIN members cm ON cm.email = gc.challenger_email
       JOIN members om ON om.email = gc.opponent_email
       WHERE gc.challenger_email = $1 OR gc.opponent_email = $1
       ORDER BY gc.created_at DESC
       LIMIT 50`,
      [email]
    );

    const now = new Date();
    const challenges = rows.map((row) => {
      const isChallenger = row.challenger_email === email;
      const expired = new Date(row.expires_at) < now && row.status === "pending";
      return {
        id: row.id,
        gameId: row.game_id,
        gameDate: row.game_date,
        direction: isChallenger ? "outgoing" : "incoming",
        challengerName: row.challenger_name,
        challengerAvatar: row.challenger_avatar,
        opponentName: row.opponent_name,
        opponentAvatar: row.opponent_avatar,
        challengerScore: row.challenger_score,
        opponentScore: row.opponent_score,
        status: expired ? "expired" : row.status,
        winnerEmail: row.winner_email,
        isWinner: row.winner_email === email,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    });

    res.json({ challenges });
  } catch (err) {
    console.error("Get game challenges error:", err);
    res.status(500).json({ error: "Failed to fetch challenges" });
  }
});

// POST /api/game-challenges/:id/respond — opponent plays and submits their score
router.post("/game-challenges/:id/respond", async (req, res) => {
  const { email, score } = req.body as { email?: string; score?: number };
  if (!email || score == null) {
    return res.status(400).json({ error: "email and score required" });
  }
  const opponentEmail = email.toLowerCase();

  try {
    const { rows } = await pool.query(
      `SELECT * FROM game_challenges WHERE id = $1 AND status = 'pending'`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Challenge not found or already complete" });
    const challenge = rows[0];

    if (challenge.opponent_email !== opponentEmail) {
      return res.status(403).json({ error: "Not the intended opponent" });
    }

    const winnerEmail =
      score > challenge.challenger_score ? opponentEmail
      : score === challenge.challenger_score ? null
      : challenge.challenger_email;

    await pool.query(
      `UPDATE game_challenges
       SET opponent_score = $1, status = 'completed', winner_email = $2
       WHERE id = $3`,
      [score, winnerEmail, challenge.id]
    );

    // Award 25 bonus points to both players for completing a game together
    await Promise.all([
      awardPoints(challenge.challenger_email, "tribe_challenge_complete", { source: "game_challenge", challengeId: challenge.id }),
      awardPoints(opponentEmail, "tribe_challenge_complete", { source: "game_challenge", challengeId: challenge.id }),
    ]);

    const nameRow = await pool.query("SELECT name FROM members WHERE email = $1", [opponentEmail]);
    const opponentName = nameRow.rows[0]?.name ?? "Your opponent";
    const challengerNameRow = await pool.query("SELECT name FROM members WHERE email = $1", [challenge.challenger_email]);
    const challengerName = challengerNameRow.rows[0]?.name ?? "your friend";
    const label = gameLabel(challenge.game_id);

    let resultText: string;
    if (winnerEmail === opponentEmail) {
      resultText = `${opponentName} played ${label} today and scored ${score} (you scored ${challenge.challenger_score}). You both earned +25 bonus points for playing together!`;
    } else if (winnerEmail === null) {
      resultText = `${opponentName} played ${label} and matched your score exactly (${score} each). You both earned +25 bonus points!`;
    } else {
      resultText = `${opponentName} played ${label} today - you scored ${challenge.challenger_score}, they scored ${score}. You both earned +25 bonus points for playing together!`;
    }

    await createMemberNotification({
      memberEmail: challenge.challenger_email,
      type: "tribe",
      title: `${opponentName} played today`,
      body: resultText,
      link: `/games?challenge=${challenge.id}`,
      metadata: { challengeId: challenge.id, gameId: challenge.game_id },
    });

    await sendNotificationToUser(challenge.challenger_email, {
      title: `${opponentName} played ${label}!`,
      body: resultText,
      tag: "game-challenge-result",
      url: `/games?challenge=${challenge.id}`,
    });

    await createMemberNotification({
      memberEmail: opponentEmail,
      type: "tribe",
      title: "+25 bonus points earned",
      body: `You and ${challengerName} both played ${label} today. Bonus points added to your WELL Cup score!`,
      link: `/well-cup`,
      metadata: { challengeId: challenge.id, gameId: challenge.game_id },
    });

    res.json({
      ok: true,
      winnerEmail,
      challengerScore: challenge.challenger_score,
      opponentScore: score,
    });
  } catch (err) {
    console.error("Respond to game challenge error:", err);
    res.status(500).json({ error: "Failed to submit response" });
  }
});

// DELETE /api/game-challenges/:id — cancel a pending challenge you sent
router.delete("/game-challenges/:id", async (req, res) => {
  const email = (req.query.email as string | undefined)?.toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM game_challenges WHERE id = $1 AND challenger_email = $2 AND status = 'pending'`,
      [req.params.id, email]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Challenge not found or already completed" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete game challenge error:", err);
    res.status(500).json({ error: "Failed to cancel challenge" });
  }
});

// GET /api/game-challenges/:id — single challenge for result view
router.get("/game-challenges/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT gc.*,
              cm.name AS challenger_name, cm.avatar AS challenger_avatar,
              om.name AS opponent_name, om.avatar AS opponent_avatar
       FROM game_challenges gc
       JOIN members cm ON cm.email = gc.challenger_email
       JOIN members om ON om.email = gc.opponent_email
       WHERE gc.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    const row = rows[0];
    res.json({
      id: row.id,
      gameId: row.game_id,
      gameDate: row.game_date,
      challengerEmail: row.challenger_email,
      challengerName: row.challenger_name,
      challengerAvatar: row.challenger_avatar,
      opponentEmail: row.opponent_email,
      opponentName: row.opponent_name,
      opponentAvatar: row.opponent_avatar,
      challengerScore: row.challenger_score,
      opponentScore: row.opponent_score,
      status: row.status,
      winnerEmail: row.winner_email,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    console.error("Get challenge error:", err);
    res.status(500).json({ error: "Failed to fetch challenge" });
  }
});

export default router;
