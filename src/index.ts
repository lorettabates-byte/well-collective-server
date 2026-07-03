import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { initDb } from "./db";
import authRouter from "./routes/auth";
import blogNotificationsRouter from "./routes/blog-notifications";
import breathworkRouter from "./routes/breathwork";
import contentRouter from "./routes/content";
import couponsRouter from "./routes/coupons";
import eventsRouter from "./routes/events";
import forumRouter from "./routes/forum";
import inspirationReactionsRouter from "./routes/inspirationReactions";
import liveEventNotificationsRouter from "./routes/live-event-notifications";
import membersRouter from "./routes/members";
import membershipRouter from "./routes/membership";
import messagesRouter from "./routes/messages";
import peacefulSoundsRouter from "./routes/peacefulSounds";
import recipesRouter from "./routes/recipes";
import settingsRouter from "./routes/settings";
import songsRouter from "./routes/songs";
import subscriptionsRouter from "./routes/subscriptions";
import pointsRouter from "./routes/points";
import tribeRouter from "./routes/tribe";
import videoNotificationsRouter from "./routes/video-notifications";
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
    // iOS standalone/home-screen PWAs sometimes send `Origin: null` for
    // cross-origin fetches (a known WebKit quirk in sandboxed contexts) --
    // without allowing it, those requests get silently blocked client-side
    // with a generic "Load failed" before they ever reach this server.
    // Safe to allow here since this API never relies on cookies/credentials.
    origin: allowedOrigins.length > 0 ? [...allowedOrigins, "null"] : true,
  })
);
// Default express.json() body limit is 100kb, which a real uploaded photo
// (base64-encoded) blows past easily — members.sync and similar endpoints
// would silently 413 with no visible error, while small built-in avatar
// images stay under the limit and save fine.
app.use(express.json({ limit: "15mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/blog", blogNotificationsRouter);
app.use("/api/live-events", liveEventNotificationsRouter);
app.use("/api/video", videoNotificationsRouter);
app.use("/api/breathwork", breathworkRouter);
app.use("/api/coupons", couponsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/forum", forumRouter);
app.use("/api", subscriptionsRouter);
app.use("/api", contentRouter);
app.use("/api", membershipRouter);
app.use("/api", songsRouter);
app.use("/api", membersRouter);
app.use("/api", settingsRouter);
app.use("/api", peacefulSoundsRouter);
app.use("/api", tribeRouter);
app.use("/api", eventsRouter);
app.use("/api", recipesRouter);
app.use("/api", inspirationReactionsRouter);
app.use("/api", pointsRouter);

async function main() {
  await initDb();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`✅ WELL Collective push server listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
