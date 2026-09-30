import { pool } from "./db";

const WP_BASE = "https://lorettabates.com/videolibrary.lorettabates.com/wp-json/well/v1";
const WELL_API_KEY = process.env.WELL_API_KEY || "";
const PAID_LEVEL = 4;
const CACHE_MS = 15 * 60 * 1000;

export interface PaidMembers {
  website: Set<string>;
  apple: Set<string>;
  fetchedAt: number;
}

let cache: PaidMembers | null = null;
let inflight: Promise<PaidMembers> | null = null;

async function wpGet<T>(path: string): Promise<T> {
  const res = await fetch(`${WP_BASE}${path}`, {
    headers: { "X-WELL-API-KEY": WELL_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WP ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// all-members "active" = level 4 or 7 with an unexpired expire_time, but can't tell
// them apart; membership-status reports levels but ignores expiry. Paid needs both.
async function load(): Promise<PaidMembers> {
  const { members } = await wpGet<{ members: { email: string; active: boolean }[] }>("/all-members");
  const candidates = members.filter((m) => m.active).map((m) => m.email.toLowerCase());

  const website = new Set<string>();
  const queue = [...candidates];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let email = queue.shift(); email; email = queue.shift()) {
        try {
          const s = await wpGet<{ levels?: number[] }>(`/membership-status?email=${encodeURIComponent(email)}`);
          if (s.levels?.includes(PAID_LEVEL)) website.add(email);
        } catch (err) {
          console.warn(`[PAID] level lookup failed for ${email}:`, err);
        }
      }
    })
  );

  // Apple subscriptions without a website account. Expiry isn't tracked server-side,
  // so this is "activated via Apple", not a live App Store check.
  const { rows } = await pool.query<{ email: string }>(
    "SELECT email FROM members WHERE membership_source = 'iap_apple' AND membership_status = 'active'"
  );
  const apple = new Set(rows.map((r) => r.email.toLowerCase()).filter((e) => !website.has(e)));

  return { website, apple, fetchedAt: Date.now() };
}

function refresh(): Promise<PaidMembers> {
  inflight ??= load()
    .then((result) => (cache = result))
    .finally(() => { inflight = null; });
  return inflight;
}

// The level lookup takes ~40s, so serve the last result while refreshing in the background.
export async function getPaidMembers(): Promise<PaidMembers> {
  if (!cache) return refresh();
  if (Date.now() - cache.fetchedAt >= CACHE_MS) refresh().catch((err) => console.error("[PAID] refresh failed:", err));
  return cache;
}

refresh().catch((err) => console.error("[PAID] initial load failed:", err));
