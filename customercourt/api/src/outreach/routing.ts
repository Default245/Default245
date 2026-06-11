// Routing v0: lowest-tier known contact point, else a guessed support
// address. Workstream 3 replaces this with learned routing (per-company,
// per-category resolution rates).
export function contactAddress(
  company: {
    domain: string | null;
    contactPoints: { address: string; tier: number }[];
  } | null,
): string {
  if (!company) return "unknown@example.invalid";
  const point = [...company.contactPoints].sort((a, b) => a.tier - b.tier)[0];
  if (point) return point.address;
  return company.domain
    ? `support@${company.domain}.com`
    : "unknown@example.invalid";
}

// Escalation sends are emails, so non-mailable rungs are skipped: WEB_FORM
// can't receive mail, and REGULATOR contacts belong to the consumer handoff
// package, not the company ladder.
const EMAILABLE_KINDS = new Set([
  "SUPPORT_EMAIL",
  "ESCALATION_EMAIL",
  "EXECUTIVE_RELATIONS",
]);

export interface LadderRung {
  address: string;
  tier: number;
}

// Next rung up the contact ladder: the lowest-tier emailable contact point
// strictly above `tier` (the highest tier already contacted), or null when
// the ladder is exhausted. Returns the full rung so callers can record the
// tier they escalated to.
export function nextContactPoint(
  company: {
    contactPoints: { address: string; tier: number; kind: string }[];
  } | null,
  tier: number,
): LadderRung | null {
  if (!company) return null;
  const rung = company.contactPoints
    .filter((p) => p.tier > tier && EMAILABLE_KINDS.has(p.kind))
    .sort((a, b) => a.tier - b.tier)[0];
  return rung ? { address: rung.address, tier: rung.tier } : null;
}

// Address-only convenience over nextContactPoint().
export function contactAddressForTier(
  company: {
    contactPoints: { address: string; tier: number; kind: string }[];
  } | null,
  tier: number,
): string | null {
  return nextContactPoint(company, tier)?.address ?? null;
}
