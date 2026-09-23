// src/modules/pricing/promotion-ranking.ts

import { ResolvedPromotion } from './interfaces/pricing.types';

/**
 * Business ranking: priority DESC → specificity DESC → campaign-linked first.
 * Returns 0 when two promotions have the same rank.
 */
export function compareRank(
  a: ResolvedPromotion,
  b: ResolvedPromotion,
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.matchSpecificity !== b.matchSpecificity) {
    return b.matchSpecificity - a.matchSpecificity;
  }
  return Number(Boolean(b.campaignId)) - Number(Boolean(a.campaignId));
}

/** Full ordering with a deterministic final tie-break (older UUIDv7 first). */
export function comparePromotions(
  a: ResolvedPromotion,
  b: ResolvedPromotion,
): number {
  return compareRank(a, b) || a.id.localeCompare(b.id);
}
