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

async function createLogin(username) {
  await fetch(`${url}/api/admin/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": "test-admin" },
    body: JSON.stringify({ username, password: "test1234" }),
  });
  const response = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "test1234" }),
  });
  return (await response.json()).token;
}

test("两名玩家可创建、加入、准备、开局并保持暗棋隔离", { timeout: 12000 }, async (t) => {
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ADMIN_KEY: "test-admin", ACCOUNTS_FILE: `/tmp/siguo-junqi-test-${process.pid}.json` },
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
  const northToken = await createLogin("北方玩家");
  const northSessionPromise = waitEvent(north, "session");
  north.emit("create-room", { authToken: northToken, capacity: 2, mode: "ffa" });
  const northSession = await northSessionPromise;
  assert.equal(northSession.seat, "north");
  const lobby = await (await fetch(url + "/api/rooms")).json();
  assert.ok(lobby.some(room => room.code === northSession.code && room.phase === "setup"));

  const south = await connectClient();
  clients.push(south);
  const southToken = await createLogin("南方玩家");
  const southSessionPromise = waitEvent(south, "session");
  const joinedPromise = waitEvent(north, "room-state", (room) => room.players.every((player) => !player.empty));
  south.emit("join-room", { authToken: southToken, code: northSession.code });
  const enteredSession = await southSessionPromise;
  assert.equal(enteredSession.seat, null);
  const southSeatPromise = waitEvent(south, "session", session => session.seat === "south");
  south.emit("take-seat", { seat: "south" });
  const southSession = await southSeatPromise;
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
  assert.deepEqual(moved.lastMove, {
    from: "north-1-0",
    to: "north-1-1",
    pieceId: moved.pieces.find((piece) => piece.owner === "north" && piece.position === "north-1-1").id,
  });

  const southPositions = moved.pieces.filter(piece => piece.owner === "south").map(piece => piece.position).sort();
  const vacatedPromise = waitEvent(north, "room-state", room => room.phase === "playing" && room.players.find(player => player.seat === "south")?.empty);
  south.emit("leave-seat");
  const vacated = await vacatedPromise;
  assert.deepEqual(vacated.pieces.filter(piece => piece.owner === "south").map(piece => piece.position).sort(), southPositions);

  const replacement = await connectClient(); clients.push(replacement);
  const replacementToken = await createLogin("南方接替者");
  const enteredReplacement = waitEvent(replacement, "session", session => session.seat === null);
  replacement.emit("join-room", { authToken: replacementToken, code: northSession.code });
  await enteredReplacement;
  const replacementSeat = waitEvent(replacement, "session", session => session.seat === "south");
  replacement.emit("take-seat", { seat: "south" });
  await replacementSeat;
  const replacementState = await waitEvent(replacement, "room-state", room => room.viewerSeat === "south");
  assert.equal(replacementState.pieces.filter(piece => piece.owner === "south").every(piece => piece.type), true);
  assert.deepEqual(replacementState.pieces.filter(piece => piece.owner === "south").map(piece => piece.position).sort(), southPositions);

  const kicked = waitEvent(replacement, "kicked");
  const kickedVacancy = waitEvent(north, "room-state", room => room.players.find(player => player.seat === "south")?.empty);
  north.emit("kick-member", { name: "南方接替者" });
  await Promise.all([kicked, kickedVacancy]);
  const retakeSeat = waitEvent(south, "session", session => session.seat === "south");
  south.emit("take-seat", { seat: "south" });
  await retakeSeat;
  const retaken = await waitEvent(south, "room-state", room => room.viewerSeat === "south");
  assert.deepEqual(retaken.pieces.filter(piece => piece.owner === "south").map(piece => piece.position).sort(), southPositions);

  const logoutVacancy = waitEvent(north, "room-state", room => room.players.find(player => player.seat === "south")?.empty);
  const logoutResponse = await fetch(url + "/api/logout", { method: "POST", headers: { authorization: `Bearer ${southToken}` } });
  assert.equal(logoutResponse.status, 200);
  const afterLogout = await logoutVacancy;
  assert.deepEqual(afterLogout.pieces.filter(piece => piece.owner === "south").map(piece => piece.position).sort(), southPositions);

  const reloginResponse = await fetch(url + "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "南方玩家", password: "test1234" }),
  });
  const reloginToken = (await reloginResponse.json()).token;
  const southAgain = await connectClient(); clients.push(southAgain);
  const reentered = waitEvent(southAgain, "session", session => session.seat === null);
  southAgain.emit("join-room", { authToken: reloginToken, code: northSession.code });
  await reentered;
  const resumedSeat = waitEvent(southAgain, "session", session => session.seat === "south");
  southAgain.emit("take-seat", { seat: "south" });
  await resumedSeat;
  const resumed = await waitEvent(southAgain, "room-state", room => room.viewerSeat === "south");
  assert.deepEqual(resumed.pieces.filter(piece => piece.owner === "south").map(piece => piece.position).sort(), southPositions);

  const northClosed = waitEvent(north, "room-closed");
  const southClosed = waitEvent(southAgain, "room-closed");
  north.emit("close-room");
  await Promise.all([northClosed, southClosed]);
  const afterClose = await (await fetch(url + "/api/rooms")).json();
  assert.ok(!afterClose.some(room => room.code === northSession.code));

  async function openRoom(capacity, mode) {
    const owner = await connectClient();
    clients.push(owner);
    const suffix = `${capacity}${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const ownerToken = await createLogin(`房主${suffix}`);
    const ownerSessionPromise = waitEvent(owner, "session");
    owner.emit("create-room", { authToken: ownerToken, capacity, mode });
    const ownerSession = await ownerSessionPromise;
    const seats = [ownerSession.seat];
    for (let i = 1; i < capacity; i += 1) {
      const guest = await connectClient();
      clients.push(guest);
      const guestToken = await createLogin(`玩家${i}${suffix}`);
      const guestSessionPromise = waitEvent(guest, "session");
      guest.emit("join-room", { authToken: guestToken, code: ownerSession.code });
      const entered = await guestSessionPromise;
      assert.equal(entered.seat, null);
      const wanted = capacity === 2 ? "south" : ["east", "south", "west"][i - 1];
      const seatedPromise = waitEvent(guest, "session", session => session.seat === wanted);
      guest.emit("take-seat", { seat: wanted });
      seats.push((await seatedPromise).seat);
    }
    return seats;
  }

  assert.deepEqual(await openRoom(3, "ffa"), ["north", "east", "south"]);
  assert.deepEqual(await openRoom(4, "alliance"), ["north", "east", "south", "west"]);

  const reconnectOwner = await connectClient(); clients.push(reconnectOwner);
  const reconnectToken = await createLogin("重复进入测试");
  const reconnectRoomPromise = waitEvent(reconnectOwner, "session", session => session.seat === "north");
  reconnectOwner.emit("create-room", { authToken: reconnectToken, capacity: 2 });
  const reconnectRoom = await reconnectRoomPromise;
  const replacementConnection = await connectClient(); clients.push(replacementConnection);
  const replacedNotice = waitEvent(reconnectOwner, "session-replaced");
  const restoredSeat = waitEvent(replacementConnection, "session", session => session.code === reconnectRoom.code && session.seat === "north");
  const restoredStatePromise = waitEvent(replacementConnection, "room-state", room => room.viewerSeat === "north");
  replacementConnection.emit("join-room", { authToken: reconnectToken, code: reconnectRoom.code });
  await Promise.all([replacedNotice, restoredSeat]);
  const restoredState = await restoredStatePromise;
  assert.equal(restoredState.players.find(player => player.seat === "north").name, "重复进入测试");

  const watcher = await connectClient(); clients.push(watcher);
  const watcherToken = await createLogin("重复观战测试");
  const watched = waitEvent(watcher, "session", session => session.code === reconnectRoom.code && session.seat === null);
  watcher.emit("join-room", { authToken: watcherToken, code: reconnectRoom.code });
  await watched;
  const watcherAgain = await connectClient(); clients.push(watcherAgain);
  const watcherReplaced = waitEvent(watcher, "session-replaced");
  const restoredWatcher = waitEvent(watcherAgain, "session", session => session.code === reconnectRoom.code && session.seat === null);
  watcherAgain.emit("join-room", { authToken: watcherToken, code: reconnectRoom.code });
  await Promise.all([watcherReplaced, restoredWatcher]);

  const token = await createLogin("删除测试");
  const deleteUrl = url + "/api/admin/accounts/" + encodeURIComponent("删除测试");
  assert.equal((await fetch(deleteUrl, { method: "DELETE" })).status, 403);
  assert.equal((await fetch(deleteUrl, { method: "DELETE", headers: { "x-admin-key": "test-admin" } })).status, 200);
  const names = await (await fetch(url + "/api/admin/accounts", { headers: { "x-admin-key": "test-admin" } })).json();
  assert.ok(!names.includes("删除测试"));
  assert.equal((await fetch(url + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "删除测试", password: "test1234" }) })).status, 401);
  const guest = await connectClient();
  clients.push(guest);
  const denied = waitEvent(guest, "game-error");
  guest.emit("create-room", { authToken: token, capacity: 2 });
  await denied;

});
