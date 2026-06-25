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

export const SPECIAL_BADGE_IDS = ["well-escape"];
