// Mirrors well-collective-app/src/store/AppContext.tsx's deriveMemberId
// exactly (same hash, same lowercasing) so ids returned here match what the
// client already uses as `user.id` in inspiration.likes/savedBy arrays —
// no client-side remapping needed.
export function deriveMemberId(email: string): string {
  const lower = email.toLowerCase();
  let hash = 0;
  for (let i = 0; i < lower.length; i++) {
    hash = (hash << 5) - hash + lower.charCodeAt(i);
    hash |= 0;
  }
  return `m_${Math.abs(hash).toString(36)}`;
}
