import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { maybeStripe } from "../lib/stripe.js";

const prisma = new PrismaClient();

// Bank linking via Stripe Financial Connections. Two-step flow:
// 1. /bank-link creates a session; the consumer app opens the Stripe-hosted
//    auth flow with the returned client_secret.
// 2. /bank-link/confirm stores the linked account and subscribes to its
//    transaction feed so verification has data to search.
export async function bankRoutes(app: FastifyInstance) {
  app.post<{ Params: { email: string } }>(
    "/v1/consumers/:email/bank-link",
    async (req, reply) => {
      const stripe = maybeStripe();
      if (!stripe) {
        return reply
          .code(503)
          .send({ error: "bank linking not configured (STRIPE_SECRET_KEY)" });
      }

      const consumer = await prisma.consumer.findUnique({
        where: { email: req.params.email },
      });
      if (!consumer) return reply.code(404).send({ error: "consumer not found" });

      let customerId = consumer.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: consumer.email,
          name: consumer.name ?? undefined,
        });
        customerId = customer.id;
        await prisma.consumer.update({
          where: { id: consumer.id },
          data: { stripeCustomerId: customerId },
        });
      }

      const session = await stripe.financialConnections.sessions.create({
        account_holder: { type: "customer", customer: customerId },
        permissions: ["transactions"],
      });

      return { clientSecret: session.client_secret };
    },
  );

  app.post<{ Params: { email: string }; Body: { sessionId: string } }>(
    "/v1/consumers/:email/bank-link/confirm",
    {
      schema: {
        body: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string" } },
        },
      },
      handler: async (req, reply) => {
        const stripe = maybeStripe();
        if (!stripe) {
          return reply
            .code(503)
            .send({ error: "bank linking not configured (STRIPE_SECRET_KEY)" });
        }

        const consumer = await prisma.consumer.findUnique({
          where: { email: req.params.email },
        });
        if (!consumer) return reply.code(404).send({ error: "consumer not found" });

        const session = await stripe.financialConnections.sessions.retrieve(
          req.body.sessionId,
        );
        const account = session.accounts.data[0];
        if (!account) {
          return reply
            .code(422)
            .send({ error: "no account linked in this session" });
        }

        // Transactions arrive only for subscribed accounts; without this the
        // verification worker would always come up empty.
        await stripe.financialConnections.accounts.subscribe(account.id, {
          features: ["transactions"],
        });

        await prisma.consumer.update({
          where: { id: consumer.id },
          data: { fcAccountId: account.id },
        });

        return { linked: true, accountId: account.id };
      },
    },
  );
}
