import { WebSocketServer } from "ws";
import { pool } from "./db.js";

const LOCK_TTL_MS = 45_000; // a lock expires if the editor stops sending heartbeats

const clients = new Map(); // socket -> { memberId, name }
const locks = new Map();   // taskId -> { memberId, name, expiresAt }

let wss;

export function attachRealtime(server) {
  wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    clients.set(socket, { memberId: null, name: null });
    send(socket, { type: "connection.ready" });
    send(socket, { type: "locks.snapshot", locks: lockList() });

    socket.on("message", (raw) => handleMessage(socket, raw).catch(() => {}));
    socket.on("close", () => {
      clients.delete(socket);
      releaseAllFor(socket);
      broadcastPresence();
    });
  });

  setInterval(sweepLocks, 10_000).unref();
}

export function broadcast(payload) {
  if (!wss) return;
  const message = JSON.stringify(payload);
  for (const client of wss.clients) if (client.readyState === 1) client.send(message);
}

/** Who currently holds the edit lock for a task (or null). Used by the REST API too. */
export function getLock(taskId) {
  const lock = locks.get(Number(taskId));
  if (!lock || lock.expiresAt < Date.now()) return null;
  return lock;
}

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function lockList() {
  return [...locks.entries()].map(([taskId, l]) => ({ taskId, memberId: l.memberId, name: l.name }));
}

function broadcastPresence() {
  const online = new Map();
  for (const c of clients.values()) if (c.memberId) online.set(c.memberId, c.name);
  broadcast({ type: "presence", online: [...online].map(([memberId, name]) => ({ memberId, name })) });
}

async function handleMessage(socket, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return send(socket, { type: "error", message: "Invalid message" }); }
  const me = clients.get(socket);

  if (msg.type === "hello") {
    const [rows] = await pool.execute("SELECT id, name FROM members WHERE id = ?", [Number(msg.memberId)]);
    if (!rows[0]) return;
    me.memberId = rows[0].id;
    me.name = rows[0].name;
    return broadcastPresence();
  }

  if (!me?.memberId) return; // everything below requires identifying first

  const taskId = Number(msg.taskId);

  if (msg.type === "lock.acquire" || msg.type === "lock.refresh") {
    const existing = getLock(taskId);
    if (existing && existing.memberId !== me.memberId) {
      return send(socket, { type: "lock.denied", taskId, memberId: existing.memberId, name: existing.name });
    }
    const isNew = !existing;
    locks.set(taskId, { memberId: me.memberId, name: me.name, expiresAt: Date.now() + LOCK_TTL_MS, socket });
    if (isNew) broadcast({ type: "lock.acquired", taskId, memberId: me.memberId, name: me.name });
    return send(socket, { type: "lock.granted", taskId });
  }

  if (msg.type === "lock.release") {
    const existing = locks.get(taskId);
    if (existing && existing.memberId === me.memberId) {
      locks.delete(taskId);
      broadcast({ type: "lock.released", taskId });
    }
  }
}

function releaseAllFor(socket) {
  for (const [taskId, lock] of locks) {
    if (lock.socket === socket) {
      locks.delete(taskId);
      broadcast({ type: "lock.released", taskId });
    }
  }
}

function sweepLocks() {
  const now = Date.now();
  for (const [taskId, lock] of locks) {
    if (lock.expiresAt < now) {
      locks.delete(taskId);
      broadcast({ type: "lock.released", taskId });
    }
  }
}
