import { fetch } from './encrypted-client.js';
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { io } from "./encrypted-client.js";

const port = 32147;
const url = `http://127.0.0.1:${port}`;

function waitEvent(socket, event, predicate = () => true, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待 ${event} 超时：${predicate.toString()}`));
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
    headers: { "content-type": "application/json", "x-admin-key": "test-admin-key-123" },
    body: JSON.stringify({ username, password: "test1234" }),
  });
  const response = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "test1234" }),
  });
  return (await response.json()).token;
}

test("两名玩家可创建、加入、准备、开局并保持暗棋隔离", { timeout: 45000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "siguo-junqi-multiplayer-"));
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ADMIN_KEY: "test-admin-key-123", ACCOUNTS_FILE: path.join(dataDir, "accounts.json"), SIGUO_ROOMS_FILE:path.join(dataDir,'rooms.json'), SIGUO_PICTURES_DIR:path.join(dataDir,'pictures'), SIGUO_AVATARS_DIR:path.join(dataDir,'avatars') },
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
  t.after(async () => {
    for (const client of clients) client.disconnect();
    await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill('SIGTERM');});
    return rm(dataDir, { recursive: true, force: true });
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
    path: ['north-1-0', 'north-1-1'],
    from: "north-1-0",
    to: "north-1-1",
    pieceId: moved.pieces.find((piece) => piece.owner === "north" && piece.position === "north-1-1").id,
  });

  // Fully human games are now automatically Rated: no mid-game seat replacement.
  assert.equal(moved.rated,true);
  const deniedLeave=waitEvent(south,'game-error',m=>m.includes('排位'));south.emit('leave-seat');await deniedLeave;
  const positions=moved.pieces.filter(p=>p.owner==='south').map(p=>p.position).sort();
  south.disconnect();
  const southAgain=await connectClient();clients.push(southAgain);
  let pending=waitEvent(southAgain,'room-state',r=>r.viewerSeat==='south');
  southAgain.emit('join-room',{authToken:southToken,code:northSession.code});
  assert.deepEqual((await pending).pieces.filter(p=>p.owner==='south').map(p=>p.position).sort(),positions);
  pending=waitEvent(north,'room-state',r=>r.phase==='finished');
  southAgain.emit('resign');await pending;
  const closed=[waitEvent(north,'room-closed'),waitEvent(southAgain,'room-closed')];
  north.emit('close-room');await Promise.all(closed);
  assert.ok(!(await(await fetch(url+'/api/rooms')).json()).some(r=>r.code===northSession.code));

  async function openRoom(capacity, mode) {
    const matchClients=[];
    const owner = await connectClient();
    clients.push(owner);
    const suffix = `${capacity}${Date.now().toString(36)}`;
    const ownerToken = await createLogin(`房主${suffix}`);
    const ownerSessionPromise = waitEvent(owner, "session");
    owner.emit("create-room", { authToken: ownerToken, capacity, mode, rated:mode==='alliance' });
    matchClients.push(owner);
    const ownerSession = await ownerSessionPromise;
    const seats = [ownerSession.seat];
    for (let i = 1; i < capacity; i += 1) {
      const guest = await connectClient();
      matchClients.push(guest);
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
    if(mode==='alliance') {
      const ready=waitEvent(owner,'room-state',r=>r.players.every(p=>p.ready));
      for(const client of matchClients)client.emit('toggle-ready');
      await ready;
      const started=waitEvent(owner,'room-state',r=>r.phase==='playing');owner.emit('start-game');await started;
      const first=waitEvent(owner,'room-state',r=>r.players.find(p=>p.seat==='east').eliminated);
      matchClients[1].emit('resign');await first;
      const ended=waitEvent(owner,'room-state',r=>r.phase==='finished');matchClients[3].emit('resign');
      const result=await ended;
      assert.equal(result.ratingChanges.north.delta,128);assert.equal(result.ratingChanges.south.delta,128);
      assert.equal(result.ratingChanges.east.delta,-128);assert.equal(result.ratingChanges.west.delta,-128);
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

  const ratedNorth = await connectClient(); clients.push(ratedNorth);
  const ratedSouth = await connectClient(); clients.push(ratedSouth);
  const ratedNorthToken = await createLogin("排位北方");
  const ratedSouthToken = await createLogin("排位南方");
  const ratedRoomPromise = waitEvent(ratedNorth, "session", session => session.seat === "north");
  ratedNorth.emit("create-room", { authToken: ratedNorthToken, capacity: 2, mode: "ffa", rated: true });
  const ratedRoom = await ratedRoomPromise;
  const ratedEntered = waitEvent(ratedSouth, "session", session => session.seat === null);
  ratedSouth.emit("join-room", { authToken: ratedSouthToken, code: ratedRoom.code });
  await ratedEntered;
  const ratedSeated = waitEvent(ratedSouth, "session", session => session.seat === "south");
  ratedSouth.emit("take-seat", { seat: "south" });
  await ratedSeated;
  const ratedReady = waitEvent(ratedNorth, "room-state", room => room.players.every(player => player.ready));
  ratedNorth.emit("toggle-ready"); ratedSouth.emit("toggle-ready");
  await ratedReady;
  const ratedStarted = waitEvent(ratedNorth, "room-state", room => room.phase === "playing");
  ratedNorth.emit("start-game");
  await ratedStarted;
  assert.equal((await fetch(url + '/api/rooms/' + ratedRoom.code + '/replay')).status, 403);
  const cannotLeaveSeat = waitEvent(ratedSouth, "game-error", message => message.includes("排位"));
  ratedSouth.emit("leave-seat");
  await cannotLeaveSeat;
  const cannotClose = waitEvent(ratedNorth, "game-error", message => message.includes("不能关闭"));
  ratedNorth.emit("close-room");
  await cannotClose;
  const ratedFinished = waitEvent(ratedNorth, "room-state", room => room.phase === "finished" && room.ratingChanges);
  ratedSouth.emit("resign");
  const ratedResult = await ratedFinished;
  const replay = await (await fetch(url + '/api/rooms/' + ratedRoom.code + '/replay',{headers:{Authorization:`Bearer ${await createLogin('排位北方')}`}})).json();
  assert.equal(replay.frames[0].state.pieces.filter(p => p.position).length, 50);
  assert.equal(replay.frames.at(-1).state.phase, 'finished');
  assert.ok(replay.logs.length);
  assert.equal(ratedResult.ratingChanges.north.delta, 128);
  assert.equal(ratedResult.ratingChanges.south.delta, -128);
  const northAfterRating = await fetch(url + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "排位北方", password: "test1234" }) });
  const northProfile = await northAfterRating.json();
  assert.equal(northProfile.rating, 1628);
  assert.equal(northProfile.ratedGames, 1);
  assert.equal(northProfile.rank, "少尉");

  const token = await createLogin("删除测试");
  const deleteUrl = url + "/api/admin/accounts/" + encodeURIComponent("删除测试");
  assert.equal((await fetch(deleteUrl, { method: "DELETE" })).status, 403);
  assert.equal((await fetch(deleteUrl, { method: "DELETE", headers: { "x-admin-key": "test-admin-key-123" } })).status, 200);
  const names = await (await fetch(url + "/api/admin/accounts", { headers: { "x-admin-key": "test-admin-key-123" } })).json();
  assert.ok(!names.includes("删除测试"));
  assert.equal((await fetch(url + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "删除测试", password: "test1234" }) })).status, 401);
  const guest = await connectClient();
  clients.push(guest);
  const denied = waitEvent(guest, "game-error");
  guest.emit("create-room", { authToken: token, capacity: 2 });
  await denied;

});
