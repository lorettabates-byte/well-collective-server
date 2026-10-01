const SECRET = process.env.REVENUECAT_SECRET_KEY || "";
const PROJECT = process.env.REVENUECAT_PROJECT_ID || "";
const BASE = "https://api.revenuecat.com/v2";

export const revenueCatReady = Boolean(SECRET && PROJECT);

interface RcEntitlement { entitlement_id: string; expires_at: number | null }

interface RcCustomer {
  id: string;
  active_entitlements?: RcEntitlement[] | { items?: RcEntitlement[] };
}

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

// The app sets RevenueCat's appUserID to the member's email (src/utils/iap.ts), so customer ids are emails.
export async function getAppleSubscribers(): Promise<Map<string, number | null>> {
  const now = Date.now();
  const subs = new Map<string, number | null>();
  let next: string | null = `/projects/${PROJECT}/customers?limit=100`;
  for (let page = 0; next && page < 50; page++) {
    const body: { items: RcCustomer[]; next_page: string | null } = await rcGet(next);
    for (const c of body.items) {
      const ents = Array.isArray(c.active_entitlements) ? c.active_entitlements : c.active_entitlements?.items ?? [];
      const live = ents.filter((e) => e.expires_at === null || e.expires_at > now);
      if (live.length && c.id.includes("@")) {
        subs.set(c.id.toLowerCase(), live.some((e) => e.expires_at === null) ? null : Math.max(...live.map((e) => e.expires_at as number)));
      }
    }
    next = body.next_page;
  }
  return subs;
}
