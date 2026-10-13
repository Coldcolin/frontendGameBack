import { createServer } from "node:http";
import { config } from "./config.js";
import { connectDb, disconnectDb } from "./db.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime.js";
import { closeRenderer } from "./grading/renderer.js";
import { ensureStorage, seedChallenges } from "./services/challenges.js";
import { resumeLiveMatches } from "./services/matches.js";

await ensureStorage();
await connectDb();
await seedChallenges();
await resumeLiveMatches();

const server = createServer(createApp());
const io = attachRealtime(server);
server.listen(config.port, "0.0.0.0", () => {
  console.log(`[backend] listening on http://localhost:${config.port}`);
});

async function shutdown() {
  io.close();
  server.close();
  await Promise.allSettled([closeRenderer(), disconnectDb()]);
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
