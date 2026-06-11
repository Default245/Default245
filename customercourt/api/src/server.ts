import Fastify from "fastify";
import { caseRoutes } from "./routes/cases.js";
import { bankRoutes } from "./routes/bank.js";

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ ok: true }));
app.register(caseRoutes);
app.register(bankRoutes);

const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
