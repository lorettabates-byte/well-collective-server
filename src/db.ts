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

  await pool.query(`ALTER TABLE songs ADD COLUMN IF NOT EXISTS lyrics TEXT;`);

  // NULL = already released (every song added before this feature shipped).
  // A non-null value is a future Music Monday slot — the public /api/songs
  // endpoint filters these out until that moment passes, so no separate
  // "publish" cron job is needed; the song just becomes visible on its own.
  await pool.query(`ALTER TABLE songs ADD COLUMN IF NOT EXISTS release_at TIMESTAMPTZ;`);
  // Tracks whether the "new song" push has already fired for this release,
  // so the hourly check below doesn't re-notify on every run.
  await pool.query(`ALTER TABLE songs ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS song_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS song_category_links (
      song_id INT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      category_id INT NOT NULL REFERENCES song_categories(id) ON DELETE CASCADE,
      PRIMARY KEY (song_id, category_id)
    );
  `);

  // One-time rename: this category started out as "Royalty & Divine
  // Feminine" — Loretta asked to align it with her "Made Magnificent"
  // seminar instead. Existing song_category_links keep working since they
  // reference category_id, not the name. Safe to run every deploy; only
  // matches if the old name is still there.
  await pool.query(`UPDATE song_categories SET name = 'MADE MAGNIFICENT' WHERE name = 'Royalty & Divine Feminine'`);

  // Seeded once — admin can rename/delete/add more from the Music admin
  // page afterward, this just gives every song a starting home so the
  // playlist isn't uncategorized on day one.
  const SEED_CATEGORIES = [
    "Self-Worth & Affirmation",
    "Body Positivity & Self-Acceptance",
    "Resilience & Strength",
    "New Beginnings & Courage",
    "Healing & Wellness",
    "Ambition & Success",
    "Sisterhood & Community",
    "MADE MAGNIFICENT",
    "MADE TO BE DIFFERENT",
  ];
  for (let i = 0; i < SEED_CATEGORIES.length; i++) {
    await pool.query(
      `INSERT INTO song_categories (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [SEED_CATEGORIES[i], i]
    );
  }

  // One-time backfill assigning each of the original 24 songs to a starting
  // category, keyed by song id (not title, since titles can have stray
  // whitespace/punctuation that's risky to match exactly). ON CONFLICT DO
  // NOTHING makes this safe to run on every deploy.
  const SONG_CATEGORY_SEED: Record<number, string[]> = {
    1: ["New Beginnings & Courage"],
    2: ["New Beginnings & Courage"],
    3: ["Healing & Wellness"],
    4: ["Self-Worth & Affirmation", "MADE MAGNIFICENT"],
    5: ["Self-Worth & Affirmation"],
    6: ["Healing & Wellness"],
    7: ["Ambition & Success"],
    8: ["Body Positivity & Self-Acceptance", "MADE TO BE DIFFERENT"],
    9: ["Resilience & Strength", "New Beginnings & Courage"],
    10: ["Resilience & Strength"],
    11: ["New Beginnings & Courage"],
    12: ["Sisterhood & Community"],
    13: ["MADE MAGNIFICENT"],
    14: ["MADE MAGNIFICENT"],
    16: ["Body Positivity & Self-Acceptance", "MADE TO BE DIFFERENT"],
    18: ["Healing & Wellness"],
    19: ["Resilience & Strength"],
    20: ["New Beginnings & Courage"],
    21: ["Ambition & Success"],
    22: ["MADE MAGNIFICENT"],
    23: ["MADE MAGNIFICENT", "Body Positivity & Self-Acceptance"],
    24: ["Ambition & Success"],
    25: ["Self-Worth & Affirmation", "MADE TO BE DIFFERENT"],
    26: ["Resilience & Strength"],
  };
  const { rows: categoryRows } = await pool.query(`SELECT id, name FROM song_categories`);
  const categoryIdByName = new Map(categoryRows.map((r) => [r.name, r.id]));
  for (const [songId, categoryNames] of Object.entries(SONG_CATEGORY_SEED)) {
    for (const name of categoryNames) {
      const categoryId = categoryIdByName.get(name);
      if (!categoryId) continue;
      await pool.query(
        `INSERT INTO song_category_links (song_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [Number(songId), categoryId]
      );
    }
  }

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

  // Optional photo attached to a post/reply, stored as a compressed base64
  // JPEG data URL the same way event images and avatars are (no object
  // storage in this app). Kept small client-side (~640px/0.6) since this
  // table grows continuously, unlike avatars/events.
  await pool.query(`ALTER TABLE forum_messages ADD COLUMN IF NOT EXISTS image TEXT;`);

  // Add edited_at columns for edit functionality
  await pool.query(`ALTER TABLE forum_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE forum_threads ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;`);

  // Add pinned_at column for admin-pinned trending posts (null = not pinned)
  await pool.query(`ALTER TABLE forum_threads ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      birthday TEXT,
      show_birthday_on_calendar BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS bio TEXT;`);
  // Saved and liked inspirations — persisted server-side so they survive
  // localStorage wipes (tracking prevention, logout, device changes, etc.)
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS saved_inspiration_ids TEXT[];`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS liked_inspiration_ids TEXT[];`);
  // Marks an email as having already claimed its one-time free trial, so the
  // signup form can reject repeat attempts (e.g. after clearing local storage).
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS trial_ends_at DATE;`);
  // Per-category push notification preferences, synced from the client's
  // NotificationSettings toggles — without this, the server has no way to
  // know a member turned a category off and broadcastNotification/
  // sendNotificationToUser would send to them regardless.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS notification_settings JSONB;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS peaceful_sounds (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'music',
      url TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Replaced free-text emoji with a curated outline-icon key — drop the old
  // column if it's still hanging around from before this change shipped.
  await pool.query(`ALTER TABLE peaceful_sounds ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'music';`);
  await pool.query(`ALTER TABLE peaceful_sounds DROP COLUMN IF EXISTS emoji;`);

  // A member's WELL Tribe — the people they've chosen to add to their own
  // page. One-directional (adding someone doesn't require them to accept),
  // matching the simplicity of likes/RSVPs elsewhere in the app.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tribe_members (
      owner_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      member_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_email, member_email)
    );
  `);

  // Lets the Home page show a tribe member's current workout streak
  // alongside their birthday — synced the same way avatar/bio/birthday are.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS workout_log TEXT[];`);

  // Which single earned badge a member has chosen to show on their avatar.
  // Null means "no preference yet" — the client falls back to their current
  // level badge.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS featured_badge TEXT;`);

  // First-seen date for this member, used to compute the "Legacy Builder"
  // auto-badge (active for over a year). Backfilled from trial_started_at
  // where available since that's the earliest accurate signup signal we had
  // before this column existed; rows with no trial record default to "now",
  // so existing non-trial members start their tenure clock from today.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
  await pool.query(`UPDATE members SET created_at = trial_started_at WHERE trial_started_at IS NOT NULL AND trial_started_at < created_at;`);

  // Special badges that can't be computed from in-app activity (e.g. "WELL
  // Escape Attendee") — granted manually by an admin rather than earned
  // automatically, so they need their own table instead of a derived stat.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_badges (
      member_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      badge_id TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (member_email, badge_id)
    );
  `);

  // One of the 3 fixed cheers (see TRIBE_CHEERS) a member sent to someone in
  // their WELL Tribe. Kept as a log rather than a toggle since cheers are a
  // repeatable encouragement, not a single like.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tribe_cheers (
      id SERIAL PRIMARY KEY,
      sender_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      recipient_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      cheer_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Ad-hoc notes the admin sends as instant push notifications (distinct
  // from the date-keyed content_schedule, since there can be any number of
  // these per day) — persisted so they show up in the app's Inspirations
  // feed under "Notes from Loretta", not just as an ephemeral push.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loretta_notes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Optional base64 JPEG, same storage pattern as avatars/event photos/forum
  // images — fine here since notes are admin-only and infrequent, unlike the
  // continuously-growing forum_messages table.
  await pool.query(`ALTER TABLE loretta_notes ADD COLUMN IF NOT EXISTS image TEXT;`);

  // Track published blog posts and videos to detect new ones for notifications
  await pool.query(`
    CREATE TABLE IF NOT EXISTS published_content (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      published_at TIMESTAMPTZ NOT NULL,
      notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_published_content_type_notified ON published_content (type, notified_at);`);

  // Guided breathwork sessions (longer pre-recorded ones: 10, 15, 30 minutes)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guided_breathwork (
      id SERIAL PRIMARY KEY,
      duration_minutes INT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      audio_url TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Admin-created community events. recurrence_group_id links every occurrence
  // of a recurring event (e.g. "every Tuesday at 9am") so the whole series can
  // be identified/deleted together, while each occurrence is still its own row
  // with its own date and RSVPs.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      date DATE NOT NULL,
      time TEXT NOT NULL,
      location TEXT,
      color TEXT NOT NULL DEFAULT '#0191CE',
      rsvps TEXT[] NOT NULL DEFAULT '{}',
      recurrence_group_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_date ON events (date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_recurrence_group ON events (recurrence_group_id);`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS image TEXT;`);

  // Lets admins mark an event as full so members see a clear banner instead
  // of RSVPing into a class that's already at capacity.
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS sold_out BOOLEAN NOT NULL DEFAULT false;`);

  // Member-created folders for organizing saved recipes (e.g. "Breakfast",
  // "Meal Prep"). Recipes themselves are snapshotted as JSONB at save time
  // (see saved_recipes below) rather than re-fetched from content_schedule,
  // so a saved recipe survives an admin later editing or deleting that date's
  // entry.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipe_folders (
      id SERIAL PRIMARY KEY,
      member_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_recipes (
      id SERIAL PRIMARY KEY,
      member_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      folder_id INT REFERENCES recipe_folders(id) ON DELETE SET NULL,
      recipe_date DATE,
      recipe JSONB NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_recipes_member ON saved_recipes (member_email);`);

  // One recipe per calendar day per member — assigning a new recipe to a
  // day that already has one replaces it (ON CONFLICT below), matching the
  // simple one-meal-planned-per-day mental model most weekly planners use.
  // Recipe is snapshotted as JSONB for the same reason as saved_recipes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meal_plan_entries (
      id SERIAL PRIMARY KEY,
      member_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      plan_date DATE NOT NULL,
      recipe JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (member_email, plan_date)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meal_plan_member ON meal_plan_entries (member_email);`);

  // Likes/saves on inspirations (daily inspiration, weekly theme, motivation
  // boost, and Notes from Loretta) were previously reconstructed entirely
  // client-side from each member's own likedInspirationIds/savedInspirationIds
  // — every member only ever saw their own reaction echoed back, never
  // anyone else's, since there was no shared store of who else reacted.
  // inspiration_id covers both real ids ("1", "2" for loretta_notes rows)
  // and the synthetic per-date ids the client generates for daily/weekly/
  // motivational content ("daily-2026-06-29", etc.) — it's just a string key,
  // not a foreign key, since those don't have their own table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inspiration_reactions (
      inspiration_id TEXT NOT NULL,
      member_email TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
      reaction TEXT NOT NULL CHECK (reaction IN ('like', 'save')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (inspiration_id, member_email, reaction)
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_inspiration_reactions_id ON inspiration_reactions (inspiration_id);`
  );
}
