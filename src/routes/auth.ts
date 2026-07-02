import bcrypt from "bcrypt";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db";
import { ADMIN_NOTIFY_EMAIL, sendNotificationToUser } from "../push";
import { addTrialContactToBrevo } from "../brevo";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "well-collective-secret-key-change-in-production";
const WORDPRESS_URL = process.env.WORDPRESS_URL || "https://lorettabates.com";
const WELL_API_KEY = process.env.WELL_API_KEY || "";

export interface AuthTokenPayload {
  adminId: number;
  email: string;
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

router.post("/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  try {
    const { rows } = await pool.query("SELECT id, email, password_hash, name FROM admin_users WHERE email = $1", [
      email.toLowerCase(),
    ]);

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const admin = rows[0];
    const passwordMatch = await bcrypt.compare(password, admin.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign({ adminId: admin.id, email: admin.email }, JWT_SECRET, { expiresIn: "30d" });

    res.json({
      token,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/member-login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const wpRes = await fetch(`${WORDPRESS_URL}/wp-json/well/v1/member-login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WELL-API-KEY": WELL_API_KEY,
      },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000),
    });

    const wpData = (await wpRes.json()) as {
      message?: string;
      email?: string;
      name?: string;
    };

    if (!wpRes.ok) {
      const message = (wpData.message || "Invalid username or password").replace(/<[^>]*>/g, "");
      return res.status(401).json({ error: message });
    }

    const email = wpData.email || "";
    const name = wpData.name || username;

    const token = jwt.sign({ email, name }, JWT_SECRET, { expiresIn: "30d" });

    res.json({ token, user: { email, name } });
  } catch (err) {
    console.error("Member login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// One trial per email, enforced server-side — the client can't be trusted to
// self-report this since clearing local storage previously let anyone restart
// a "new" 7-day trial indefinitely. A returning trial member who re-enters
// their name/email here is logged back into their existing trial (same
// trialEndsAt) instead of being rejected or having the clock reset.
router.post("/start-trial", async (req, res) => {
  const { email, name } = req.body as { email?: string; name?: string };
  if (!email?.trim()) {
    return res.status(400).json({ error: "Email is required" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const { rows } = await pool.query(
      "SELECT trial_started_at, trial_ends_at, name FROM members WHERE email = $1",
      [normalizedEmail]
    );

    if (rows.length > 0 && rows[0].trial_started_at) {
      const trialEndsAt = rows[0].trial_ends_at
        ? new Date(rows[0].trial_ends_at).toISOString().slice(0, 10)
        : undefined;
      const today = new Date().toISOString().slice(0, 10);

      if (!trialEndsAt || trialEndsAt < today) {
        return res.status(409).json({ error: "Your free trial has ended. Please log in or subscribe to continue." });
      }

      return res.json({ trialEndsAt, name: rows[0].name, resumed: true });
    }

    // No existing trial for this email -- a name is required to create one,
    // but not to log back into an existing trial above.
    if (!name?.trim()) {
      return res.status(400).json({ error: "Please enter your name to start a trial." });
    }

    const isFirstTimeJoin = rows.length === 0;

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 7);
    const trialEndsAt = trialEnd.toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO members (email, name, trial_started_at, trial_ends_at)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (email) DO UPDATE SET
         trial_started_at = now(),
         trial_ends_at = $3,
         name = COALESCE(members.name, $2)`,
      [normalizedEmail, name.trim(), trialEndsAt]
    );

    if (isFirstTimeJoin && normalizedEmail !== ADMIN_NOTIFY_EMAIL) {
      sendNotificationToUser(ADMIN_NOTIFY_EMAIL, {
        title: "New WELL Collective signup",
        body: `${name.trim()} (${normalizedEmail}) just joined as a Free Trial member.`,
        tag: "new-signup",
        url: "/admin",
      }).catch((err) => console.error("Admin signup notification failed:", err));

      addTrialContactToBrevo(normalizedEmail, name.trim(), trialEndsAt)
        .catch((err) => console.error("Brevo trial sync failed:", err));
    }

    res.json({ trialEndsAt });
  } catch (err) {
    console.error("Start trial error:", err);
    res.status(500).json({ error: "Failed to start trial" });
  }
});

router.post("/register", async (req, res) => {
  const { email, password, name } = req.body as { email?: string; password?: string; name?: string };

  if (!email || !password || !name) {
    return res.status(400).json({ error: "Email, password, and name required" });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      "INSERT INTO admin_users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
      [name, email.toLowerCase(), passwordHash]
    );

    const admin = rows[0];
    const token = jwt.sign({ adminId: admin.id, email: admin.email }, JWT_SECRET, { expiresIn: "30d" });

    res.status(201).json({
      token,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
      },
    });
  } catch (err: unknown) {
    if ((err as any)?.code === "23505") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error("Registration error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/verify", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid token" });
  }

  res.json({ valid: true, admin: payload });
});

export default router;
