import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { config, corsOrigin } from "./config.js";
import type { ClientToServer, ServerToClient, Slot, SocketAuth } from "./contracts.js";
import { activityOf, liveState, loadMatch, scoreSnapshot, setBroadcaster, slotForToken, toMatchDTO } from "./services/matches.js";

const room = (id: string) => `match:${id}`;
const playerRoom = (id: string, slot: Slot) => `match:${id}:${slot}`;
const MAX_SNAPSHOT = 400_000; // ~400 KB data URL
const MAX_SOCKETS_PER_IP = 20;

/** Client IP; behind N trusted proxies it's the Nth-from-last X-Forwarded-For entry. */
function clientIp(headers: Record<string, string | string[] | undefined>, address: string) {
  const xff = headers["x-forwarded-for"];
  if (!config.trustProxy || typeof xff !== "string") return address;
  const hops = xff.split(",").map((h) => h.trim());
  return hops[Math.max(0, hops.length - config.trustProxy)] || address;
}

export function attachRealtime(server: HttpServer) {
  const io = new Server<ClientToServer, ServerToClient>(server, {
    cors: { origin: corsOrigin },
    maxHttpBufferSize: 1e6,
  });

  setBroadcaster({
    state: (m) => io.to(room(m.id)).emit("match:state", toMatchDTO(m)),
    ended: (m) => io.to(room(m.id)).emit("match:ended", toMatchDTO(m)),
  });

  const perIp = new Map<string, number>();
  io.use((socket, next) => {
    const ip = clientIp(socket.handshake.headers, socket.handshake.address);
    const n = perIp.get(ip) ?? 0;
    if (n >= MAX_SOCKETS_PER_IP) return next(new Error("Too many connections"));
    perIp.set(ip, n + 1);
    socket.once("disconnect", () => {
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
    });
    next();
  });

  io.on("connection", async (socket) => {
    // Registered before any await so a client that drops mid-handshake is still counted out.
    let counted: { id: string; slot: Slot } | null = null;
    socket.on("disconnect", async () => {
      if (!counted) return;
      const { id, slot } = counted;
      const state = liveState(id);
      state.connected[slot] = Math.max(0, state.connected[slot] - 1);
      const fresh = await loadMatch(id).catch(() => null);
      if (fresh) io.to(room(id)).emit("match:state", toMatchDTO(fresh));
    });

    const { matchId, token } = (socket.handshake.auth ?? {}) as SocketAuth;
    const match = matchId ? await loadMatch(matchId).catch(() => null) : null;
    if (!match || socket.disconnected) {
      socket.disconnect(true);
      return;
    }
    const id = match.id;
    const slot = slotForToken(match, token);
    const state = liveState(id);

    await socket.join(room(id));
    socket.emit("session", { slot });
    if (slot) {
      await socket.join(playerRoom(id, slot));
      if (socket.disconnected) return;
      state.connected[slot]++;
      counted = { id, slot };
      io.to(room(id)).emit("match:state", toMatchDTO(match));
    } else {
      await socket.join(`${room(id)}:spectators`);
      socket.emit("match:state", toMatchDTO(match));
    }

    socket.on("code:update", ({ code }) => {
      if (!slot || typeof code !== "string" || code.length > 100_000) return;
      // The first sync after joining isn't typing; only later changes are.
      const edited = state.code[slot] !== undefined && state.code[slot] !== code;
      state.code[slot] = code;
      if (!edited) return;
      const wasIdle = activityOf(id, slot) === "idle";
      state.lastEdit[slot] = Date.now();
      if (wasIdle) socket.to(room(id)).emit("player:activity", { slot, activity: "typing" });
    });

    socket.on("snapshot", async ({ png }) => {
      if (!slot || typeof png !== "string" || png.length > MAX_SNAPSHOT) return;
      // The score comes from the image itself, never from the client.
      const liveScore = await scoreSnapshot(id, slot, match.challenge, png);
      if (liveScore === null) return;
      state.liveScore[slot] = liveScore;
      const score = { slot, liveScore, activity: activityOf(id, slot) };
      io.to(room(id)).emit("player:score", score);
      // Only spectators see canvases; contenders just see each other's scores.
      io.to(`${room(id)}:spectators`).emit("player:snapshot", { ...score, png });
    });
  });

  return io;
}
