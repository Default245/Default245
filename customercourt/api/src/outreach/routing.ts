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
