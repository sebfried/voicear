export type TabClaim = { tabId: string; revision: number };

export const parseTabClaim = (value: unknown): TabClaim | null => {
  if (!value) return null;
  try {
    const claim = (typeof value === "string" ? JSON.parse(value) : value) as Partial<TabClaim>;
    return typeof claim.tabId === "string" && Number.isSafeInteger(claim.revision) && claim.revision! >= 0
      ? { tabId: claim.tabId, revision: claim.revision! }
      : null;
  } catch {
    return null;
  }
};

export const compareTabClaims = (left: TabClaim, right: TabClaim) =>
  left.revision - right.revision || left.tabId.localeCompare(right.tabId);

export const nextTabClaim = (tabId: string, ...claims: Array<TabClaim | null>): TabClaim => ({
  tabId,
  revision: Math.max(0, ...claims.map((claim) => claim?.revision ?? 0)) + 1
});
