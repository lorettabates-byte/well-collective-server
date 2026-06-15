const WORDPRESS_URL = process.env.WORDPRESS_URL || "https://lorettabates.com";
const WELL_API_KEY = process.env.WELL_API_KEY || "";

// The founder/site owner doesn't have a UMP subscription record of her own,
// so the WordPress membership-status check always returns active:false for
// this address. Treat it as always-active so admin push notifications and
// the trial banner aren't blocked for her.
const FOUNDER_EMAIL = "loretta@lorettabates.com";

// Verify membership status against WordPress Ultimate Membership Pro via the
// well/v1/membership-status endpoint (added to WordPress through Code Snippets).
export async function verifyMembership(email: string): Promise<boolean> {
  if (email.toLowerCase() === FOUNDER_EMAIL) {
    return true;
  }

  if (!WELL_API_KEY) {
    console.warn("WELL_API_KEY not set, skipping membership verification");
    return true; // Allow if not configured (fail open)
  }

  try {
    const response = await fetch(
      `${WORDPRESS_URL}/wp-json/well/v1/membership-status?email=${encodeURIComponent(email)}`,
      {
        headers: {
          "X-WELL-API-KEY": WELL_API_KEY,
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!response.ok) {
      console.warn(`Membership check failed for ${email}: HTTP ${response.status}`);
      return true; // Allow if verification fails (fail open)
    }

    const data = (await response.json()) as { active?: boolean };
    return data.active === true;
  } catch (err) {
    console.error("Membership verification error:", err);
    return true; // On error, allow (fail open)
  }
}

// Check multiple subscriptions for membership
export async function filterActiveMemberSubscriptions(
  subscriptions: Array<{ endpoint: string; email?: string; user_email?: string }>
): Promise<Array<{ endpoint: string; email?: string; user_email?: string }>> {
  const active = [];

  for (const sub of subscriptions) {
    const email = sub.email || sub.user_email;
    if (!email) {
      active.push(sub); // No email = allow (safety default)
      continue;
    }

    const isMember = await verifyMembership(email);
    if (isMember) {
      active.push(sub);
    }
  }

  return active;
}
