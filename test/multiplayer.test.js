import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";

const port = 32147;
const url = `http://127.0.0.1:${port}`;

function waitEvent(socket, event, predicate = () => true, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待 ${event} 超时`));
    }, timeout);
    const handler = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });
}

function connectClient() {
  const socket = io(url, { transports: ["websocket"], forceNew: true });
  return waitEvent(socket, "connect").then(() => socket);
}

test("两名玩家可创建、加入、准备、开局并保持暗棋隔离", { timeout: 12000 }, async (t) => {
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务器启动超时")), 3000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("已启动")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });

  const clients = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
    child.kill("SIGTERM");
  });

  const north = await connectClient();
  clients.push(north);
  const northSessionPromise = waitEvent(north, "session");
  north.emit("create-room", { name: "北方玩家", capacity: 2, mode: "ffa" });
  const northSession = await northSessionPromise;
  assert.equal(northSession.seat, "north");

  const south = await connectClient();
  clients.push(south);
  const southSessionPromise = waitEvent(south, "session");
  const joinedPromise = waitEvent(north, "room-state", (room) => room.players.every((player) => !player.empty));
  south.emit("join-room", { name: "南方玩家", code: northSession.code });
  const southSession = await southSessionPromise;
  assert.equal(southSession.seat, "south");
  await joinedPromise;

  const allReadyPromise = waitEvent(north, "room-state", (room) => room.players.every((player) => player.ready));
  north.emit("toggle-ready");
  south.emit("toggle-ready");
  await allReadyPromise;

  const northStartedPromise = waitEvent(north, "room-state", (room) => room.phase === "playing");
  const southStartedPromise = waitEvent(south, "room-state", (room) => room.phase === "playing");
  north.emit("start-game");
  const [northState, southState] = await Promise.all([northStartedPromise, southStartedPromise]);
  assert.equal(northState.turn, "north");
  assert.equal(northState.pieces.filter((piece) => piece.owner === "north").every((piece) => piece.type), true);
  assert.equal(northState.pieces.filter((piece) => piece.owner === "south").every((piece) => piece.type === null), true);
  assert.equal(southState.pieces.filter((piece) => piece.owner === "north").every((piece) => piece.type === null), true);

  const movedPromise = waitEvent(north, "room-state", (room) => room.turn === "south");
  north.emit("move", { from: "north-1-0", to: "north-1-1" });
  const moved = await movedPromise;
  assert.equal(moved.pieces.some((piece) => piece.owner === "north" && piece.position === "north-1-1"), true);

  async function openRoom(capacity, mode) {
    const owner = await connectClient();
    clients.push(owner);
    const ownerSessionPromise = waitEvent(owner, "session");
    owner.emit("create-room", { name: "房主", capacity, mode });
    const ownerSession = await ownerSessionPromise;
    const seats = [ownerSession.seat];
    for (let i = 1; i < capacity; i += 1) {
      const guest = await connectClient();
      clients.push(guest);
      const guestSessionPromise = waitEvent(guest, "session");
      guest.emit("join-room", { name: `玩家${i + 1}`, code: ownerSession.code });
      seats.push((await guestSessionPromise).seat);
    }
    return seats;
  }

  assert.deepEqual(await openRoom(3, "ffa"), ["north", "east", "south"]);
  assert.deepEqual(await openRoom(4, "alliance"), ["north", "east", "south", "west"]);
});
