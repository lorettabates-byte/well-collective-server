import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { initDb } from "./db";
import authRouter from "./routes/auth";
import contentRouter from "./routes/content";
import subscriptionsRouter from "./routes/subscriptions";
import { startScheduler } from "./scheduler";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api", subscriptionsRouter);
app.use("/api", contentRouter);

async function main() {
  await initDb();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`WELL Collective push server listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
