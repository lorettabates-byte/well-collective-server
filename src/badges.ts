// Mirrors LEVEL_BADGES / SPECIAL_BADGE_IDS in the client's src/data/badges.ts.
// A member's level is derived from forum participation + workout activity;
// special badges (e.g. "well-escape") are granted manually by an admin and
// stored in member_badges instead, since they can't be computed.
export function computeLevelBadge(messageCount: number, workoutCount: number): string {
  const score = messageCount + workoutCount;
  if (score >= 50) return "well-champion";
  if (score >= 20) return "committed-member";
  if (score >= 5) return "active-member";
  return "new-member";
}

export const SPECIAL_BADGE_IDS = ["well-escape", "made-magnificent", "made-to-be-different", "founding-member"];

// Earned automatically alongside the level badge. Legacy Builder needs a
// real join date — created_at is backfilled from trial_started_at where we
// have it, otherwise defaults to "now" for older rows with no historical
// signup record, so it only starts counting tenure from today for those.
export function computeBonusBadges(
  createdAt: Date | string | null | undefined,
  messageCount: number,
  cheersSent: number
): string[] {
  const bonus: string[] = [];
  if (createdAt) {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    if (new Date(createdAt) <= oneYearAgo) bonus.push("legacy-builder");
  }
  if (messageCount >= 10 && cheersSent >= 5) bonus.push("well-ambassador");
  return bonus;
}
