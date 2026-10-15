import { pool } from "./db";
import { getAppleSubscribers, getStorePaidHistory, revenueCatReady, type AppleSub } from "./revenuecat";
import { syncAppleSubscribers } from "./winback";
import { reconcileFromSnapshot, getFlag, SEED_VERSION, type Source } from "./membershipEvents";

const WP_BASE = "https://lorettabates.com/videolibrary.lorettabates.com/wp-json/well/v1";
const WELL_API_KEY = process.env.WELL_API_KEY || "";
const CACHE_MS = 15 * 60 * 1000;

// Loretta's family, team, and test accounts hold comp memberships, not real income.
const EXCLUDED_EMAIL = /loretta|rettabates|wellescape|kendallarianab|wmorganbates/i;
const EXCLUDED_NAME = /^(loretta bates|kendall bates|morgan bates|lloyd killian)$/i;

export function isExcludedAccount(email: string, name?: string | null): boolean {
  return EXCLUDED_EMAIL.test(email) || EXCLUDED_NAME.test((name ?? "").trim());
}

export interface PaidMembers {
  website: Set<string>;
  apple: Set<string>; // App Store subscribers (RevenueCat)
  play: Set<string>; // Google Play subscribers (RevenueCat)
  appleSource: "revenuecat" | "app_records";
  appleError?: string;
  appleExpires: Map<string, string>;
  appleCancelling: Set<string>;
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
  const { members } = await wpGet<{ members: { email: string; name?: string | null; gateway?: string | null; started_at?: string | null }[] }>("/paid-members");
  const website = new Set(
    members.filter((m) => !isExcludedAccount(m.email, m.name)).map((m) => m.email.toLowerCase())
  );

  // RevenueCat knows live App Store status. Without it, fall back to the app's own purchase
  // records, which never expire and so overcount cancelled subscribers.
  let appleEmails: string[] = [];
  let playEmails: string[] = [];
  let appleSource: PaidMembers["appleSource"] | undefined;
  let appleError: string | undefined;
  const appleExpires = new Map<string, string>();
  const appleCancelling = new Set<string>();
  let storeSubs = new Map<string, AppleSub>();
  if (revenueCatReady) {
    try {
      const subs = await getAppleSubscribers();
      storeSubs = subs;
      appleEmails = [...subs].filter(([, s]) => s.store !== "play_store").map(([e]) => e);
      playEmails = [...subs].filter(([, s]) => s.store === "play_store").map(([e]) => e);
      await syncAppleSubscribers(subs).catch((err) => console.error("[PAID] Apple subscriber sync failed:", err));
      subs.forEach((sub, e) => {
        if (sub.endsAt) appleExpires.set(e, new Date(sub.endsAt).toISOString());
        if (sub.willRenew === false) appleCancelling.add(e);
      });
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
    appleEmails = rows.filter((r) => !isExcludedAccount(r.email, r.name)).map((r) => r.email.toLowerCase());
    appleSource = "app_records";
  }
  const apple = new Set(appleEmails.filter((e) => !isExcludedAccount(e) && !website.has(e)));
  const play = new Set(playEmails.filter((e) => !isExcludedAccount(e) && !website.has(e) && !apple.has(e)));

  if (appleSource === "revenuecat") {
    trackMovement(members, website, storeSubs).catch((err) => console.error("[MEMBERSHIP] reconcile failed:", err));
  }

  return { website, apple, play, appleSource, appleError, appleExpires, appleCancelling, fetchedAt: Date.now() };
}

const GATEWAY: Record<string, string> = { stripe_connect: "Stripe", stripe: "Stripe", paypal: "PayPal" };

// Only runs on a full read (website + RevenueCat), so a failed lookup never looks like everyone left.
async function trackMovement(
  members: { email: string; name?: string | null; gateway?: string | null; started_at?: string | null }[],
  website: Set<string>,
  storeSubs: Map<string, AppleSub>
): Promise<void> {
  const web = new Map<string, { name?: string | null; gateway?: string | null; startedAt?: string | null }>();
  for (const m of members) {
    const e = m.email.toLowerCase();
    if (website.has(e)) web.set(e, { name: m.name, gateway: m.gateway ? GATEWAY[m.gateway] ?? m.gateway : null, startedAt: m.started_at ?? null });
  }
  const store = new Map<string, { store: "app_store" | "google_play"; willRenew: boolean | null; endsAt: number | null; startedAt: number | null }>();
  for (const [e, sub] of storeSubs) {
    if (isExcludedAccount(e) || website.has(e)) continue;
    store.set(e, { store: sub.store === "play_store" ? "google_play" : "app_store", willRenew: sub.willRenew, endsAt: sub.endsAt, startedAt: sub.startedAt ?? sub.firstSeenAt });
  }

  let lapsed: { email: string; name?: string | null; source: Source; startedAt?: string | number | null; endedAt: string | number }[] | undefined;
  if ((await getFlag("seeded")) !== SEED_VERSION) {
    lapsed = [];
    // Only people who really paid: trial members were once moved onto Level 4 for free.
    const wl = await wpGet<{ members: { email: string; name?: string | null; ended_at: string; started_at?: string | null; paid_months?: string | number }[] }>("/lapsed-members?days=120");
    for (const m of wl.members) {
      if (Number(m.paid_months ?? 0) <= 0 || isExcludedAccount(m.email, m.name)) continue;
      lapsed.push({ email: m.email.toLowerCase(), name: m.name, source: "website", startedAt: m.started_at ?? null, endedAt: m.ended_at });
    }
    const history = await getStorePaidHistory().catch((err) => { console.error("[MEMBERSHIP] store history failed:", err); return []; });
    for (const h of history) {
      if (h.givesAccess || !h.endedAt || website.has(h.email) || isExcludedAccount(h.email)) continue;
      lapsed.push({ email: h.email, source: h.store, startedAt: h.startedAt, endedAt: h.endedAt });
    }
    const live = new Map(history.filter((h) => h.givesAccess).map((h) => [h.email, h.startedAt] as const));
    for (const [e, s] of store) { const started = live.get(e); if (started) s.startedAt = started; }
  }
  await reconcileFromSnapshot({ website: web, store, lapsed });
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
