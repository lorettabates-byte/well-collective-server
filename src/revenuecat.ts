const SECRET = process.env.REVENUECAT_SECRET_KEY || "";
const PROJECT = process.env.REVENUECAT_PROJECT_ID || "";
const BASE = "https://api.revenuecat.com/v2";

export const revenueCatReady = Boolean(SECRET && PROJECT);

interface RcEntitlement { entitlement_id: string; expires_at: number | null }

async function rcGet<T>(pathOrUrl: string): Promise<T> {
  // next_page may come back absolute or as a "/v2/..." path.
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : pathOrUrl.startsWith("/v2/") ? `https://api.revenuecat.com${pathOrUrl}` : `${BASE}${pathOrUrl}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SECRET}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`RevenueCat ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export interface AppleSub {
  firstSeenAt: number | null;
  endsAt: number | null;
  // null when the key can't read subscriptions (only customers), so cancel intent is unknown.
  willRenew: boolean | null;
}

interface RcSubscription {
  gives_access?: boolean;
  auto_renewal_status?: string;
  current_period_ends_at?: number | null;
}

// The app sets RevenueCat's appUserID to the member's email (src/utils/iap.ts), so customer ids are emails.
export async function getAppleSubscribers(): Promise<Map<string, AppleSub>> {
  const ids: string[] = [];
  const firstSeen = new Map<string, number | null>();
  let next: string | null = `/projects/${PROJECT}/customers?limit=100`;
  for (let page = 0; next && page < 50; page++) {
    const body: { items: { id: string; first_seen_at?: number | null }[]; next_page: string | null } = await rcGet(next);
    for (const c of body.items) if (c.id.includes("@")) { ids.push(c.id); firstSeen.set(c.id, c.first_seen_at ?? null); }
    next = body.next_page;
  }

  const subs = new Map<string, AppleSub>();
  const now = Date.now();
  let canReadSubscriptions = true;
  for (const id of ids) {
    const base = `/projects/${PROJECT}/customers/${encodeURIComponent(id)}`;
    if (canReadSubscriptions) {
      try {
        const { items } = await rcGet<{ items: RcSubscription[] }>(`${base}/subscriptions`);
        const live = items.filter((x) => x.gives_access);
        if (live.length) {
          const endsAt = Math.max(...live.map((x) => x.current_period_ends_at ?? 0)) || null;
          subs.set(id.toLowerCase(), { firstSeenAt: firstSeen.get(id) ?? null, endsAt, willRenew: live.some((x) => x.auto_renewal_status !== "will_not_renew") });
        }
        continue;
      } catch (err) {
        if (!String(err).includes("RevenueCat 403")) throw err;
        canReadSubscriptions = false;
      }
    }
    const { items } = await rcGet<{ items: RcEntitlement[] }>(`${base}/active_entitlements`);
    const live = items.filter((e) => e.expires_at === null || e.expires_at > now);
    if (live.length) {
      subs.set(id.toLowerCase(), {
        firstSeenAt: firstSeen.get(id) ?? null,
        endsAt: live.some((e) => e.expires_at === null) ? null : Math.max(...live.map((e) => e.expires_at as number)),
        willRenew: null,
      });
    }
  }
  return subs;
}
