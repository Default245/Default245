import Stripe from "stripe";

let client: Stripe | null = null;

// Stripe is optional in dev: routes and providers that need it degrade
// explicitly (503 / unverified) instead of crashing at boot.
export function maybeStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  client ??= new Stripe(key);
  return client;
}
