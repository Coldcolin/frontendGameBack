import mongoose from "mongoose";
import { config } from "./config.js";

let memoryServer: { stop: () => Promise<boolean> } | null = null;

/**
 * Connects to MONGODB_URI. Without one, starts an in-memory MongoDB so the app
 * runs with no local install (data is lost on restart).
 */
export async function connectDb(uri = config.mongoUri): Promise<string> {
  let target = uri;
  if (!target) {
    if (process.env.NODE_ENV === "production") throw new Error("[db] MONGODB_URI is required in production");
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const server = await MongoMemoryServer.create();
    memoryServer = server;
    target = server.getUri("diffarena");
    console.warn("[db] MONGODB_URI not set — using in-memory MongoDB (data resets on restart)");
  }
  await mongoose.connect(target);
  return target;
}

export async function disconnectDb() {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
  memoryServer = null;
}
