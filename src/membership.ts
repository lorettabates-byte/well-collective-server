// Verify membership status against WordPress Ultimate Membership Pro
export async function verifyMembership(email: string): Promise<boolean> {
  try {
    // Query WordPress REST API for member status
    const response = await fetch(
      'https://lorettabates.com/wp-json/wp/v2/users',
      {
        headers: {
          'Authorization': `Bearer ${process.env.WORDPRESS_API_TOKEN || ''}`,
        },
      }
    );

    if (!response.ok) {
      console.warn('Failed to verify membership, allowing notification');
      return true; // Allow if verification fails (fallback to safe default)
    }

    const users = (await response.json()) as Array<any>;
    const user = users.find((u: any) => u.email === email);

    if (!user) {
      return false; // User not found = not a member
    }

    // Check if user has active membership meta
    // Ultimate Membership Pro stores membership status in user meta
    // Check for membership_level or subscription_status
    const membershipStatus = user.acf?.membership_status || user.meta?.membership_status || null;

    if (!membershipStatus) {
      return false; // No membership = not a member
    }

    // Check if status is "active" or similar
    return membershipStatus.toLowerCase() === 'active';
  } catch (err) {
    console.error('Membership verification error:', err);
    // On error, allow notification (better to send than block)
    return true;
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
