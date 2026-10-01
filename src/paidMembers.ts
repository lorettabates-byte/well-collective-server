import { pool } from "./db";
import { getAppleSubscribers, revenueCatReady } from "./revenuecat";

const WP_BASE = "https://lorettabates.com/videolibrary.lorettabates.com/wp-json/well/v1";
const WELL_API_KEY = process.env.WELL_API_KEY || "";
const CACHE_MS = 15 * 60 * 1000;

// Loretta's family, team, and test accounts hold comp memberships, not real income.
const EXCLUDED_EMAIL = /loretta|rettabates|wellescape|kendallarianab|wmorganbates/i;
const EXCLUDED_NAME = /^(loretta bates|kendall bates|morgan bates|lloyd killian)$/i;

function isExcluded(email: string, name?: string | null): boolean {
  return EXCLUDED_EMAIL.test(email) || EXCLUDED_NAME.test((name ?? "").trim());
}

export interface PaidMembers {
  website: Set<string>;
  apple: Set<string>;
  appleSource: "revenuecat" | "app_records";
  appleError?: string;
  appleExpires: Map<string, string>;
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

// Paid = a real Stripe/PayPal charge for Level 4 in the last 35 days (wordpress-snippets/paid-members.php).
// Level 4 alone isn't proof: lapsed trials were moved onto it for free.
async function load(): Promise<PaidMembers> {
  const { members } = await wpGet<{ members: { email: string; name?: string | null }[] }>("/paid-members");
  const website = new Set(
    members.filter((m) => !isExcluded(m.email, m.name)).map((m) => m.email.toLowerCase())
  );

  // RevenueCat knows live App Store status. Without it, fall back to the app's own purchase
  // records, which never expire and so overcount cancelled subscribers.
  let appleEmails: string[] = [];
  let appleSource: PaidMembers["appleSource"] | undefined;
  let appleError: string | undefined;
  const appleExpires = new Map<string, string>();
  if (revenueCatReady) {
    try {
      const subs = await getAppleSubscribers();
      appleEmails = [...subs.keys()];
      subs.forEach((exp, e) => { if (exp) appleExpires.set(e, new Date(exp).toISOString()); });
      appleSource = "revenuecat";
    } catch (err) {
      appleError = String(err instanceof Error ? err.message : err).slice(0, 300);
      console.error("[PAID] RevenueCat lookup failed, using app purchase records:", err);
    }
  }
  if (!appleSource) {
    const { rows } = await pool.query<{ email: string; name: string | null }>(
      "SELECT email, name FROM members WHERE membership_source = 'iap_apple' AND membership_status = 'active'"
    );
    appleEmails = rows.filter((r) => !isExcluded(r.email, r.name)).map((r) => r.email.toLowerCase());
    appleSource = "app_records";
  }
  const apple = new Set(appleEmails.filter((e) => !isExcluded(e) && !website.has(e)));

  return { website, apple, appleSource, appleError, appleExpires, fetchedAt: Date.now() };
}

function refresh(): Promise<PaidMembers> {
  inflight ??= load()
    .then((result) => (cache = result))
    .finally(() => { inflight = null; });
  return inflight;
}

export async function getPaidMembers(): Promise<PaidMembers> {
  if (!cache) return refresh();
  if (Date.now() - cache.fetchedAt >= CACHE_MS) refresh().catch((err) => console.error("[PAID] refresh failed:", err));
  return cache;
}

refresh().catch((err) => console.error("[PAID] initial load failed:", err));
