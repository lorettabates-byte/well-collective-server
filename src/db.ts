import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_email TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_schedule (
      date DATE PRIMARY KEY,
      weekly_theme JSONB,
      daily_inspiration JSONB,
      well_activity JSONB,
      recipe JSONB
    );
  `);

  await pool.query(`ALTER TABLE content_schedule ADD COLUMN IF NOT EXISTS motivation_boost JSONB;`);
  await pool.query(`ALTER TABLE content_schedule ADD COLUMN IF NOT EXISTS nutrition_tip TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_log (
      date DATE NOT NULL,
      kind TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (date, kind)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      description TEXT,
      discount_type TEXT NOT NULL,
      discount_value DECIMAL(10, 2) NOT NULL,
      max_uses INT,
      used_count INT DEFAULT 0,
      expires_at DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INT REFERENCES admin_users(id)
    );
  `);

  await pool.query(`ALTER TABLE coupons ADD COLUMN IF NOT EXISTS pool TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id SERIAL PRIMARY KEY,
      coupon_id INT NOT NULL REFERENCES coupons(id),
      user_id TEXT NOT NULL,
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      body TEXT NOT NULL,
      read BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recipient ON messages (recipient_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversation ON messages (sender_id, recipient_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS songs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      url TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS forum_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      color TEXT,
      sort_order INT NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS forum_threads (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES forum_categories(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_avatar TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS forum_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_avatar TEXT,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      likes TEXT[] NOT NULL DEFAULT '{}',
      reply_to_id TEXT
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_forum_threads_category ON forum_threads (category_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_forum_messages_thread ON forum_messages (thread_id);`);

  // One-time seed of the original built-in categories so the move to a shared
  // backend doesn't drop them. Uses ON CONFLICT DO NOTHING so admin edits made
  // afterward are never overwritten by this.
  const defaultCategories: Array<[string, string, string, string, string, number]> = [
    ["introductions", "Introductions", "Say hello & introduce yourself to the WELL family", "hand", "#0191CE", 0],
    ["wellness-nutrition", "Wellness & Nutrition", "Recipes, habits, and nourishment tips", "salad", "#84D8FD", 1],
    ["fitness-movement", "Fitness & Movement", "Workouts, movement wins, and motivation", "dumbbell", "#01519D", 2],
    ["emotional-spiritual", "Emotional & Spiritual Growth", "Mindfulness, journaling, and inner work", "leaf", "#0191CE", 3],
    ["success-stories", "Success Stories", "Celebrate wins — big or small", "award", "#84D8FD", 4],
    ["general-chat", "General Chat", "Anything & everything WELL Collective", "messages", "#01519D", 5],
  ];
  for (const [id, name, description, icon, color, sortOrder] of defaultCategories) {
    await pool.query(
      `INSERT INTO forum_categories (id, name, description, icon, color, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [id, name, description, icon, color, sortOrder]
    );
  }
}
