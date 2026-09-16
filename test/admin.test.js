import {fetch} from "./encrypted-client.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { io } from "./encrypted-client.js";

function waitEvent(socket, event, predicate = () => true, timeout = 4000) {
  const error=new Error(`等待 ${event} 超时：${predicate}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(error);
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

function connectClient(url) {
  const socket = io(url, { transports: ["websocket"], forceNew: true });
  return waitEvent(socket, "connect").then(() => socket);
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ADMIN_KEY: "admin-test-admin-key-123", ACCOUNTS_FILE: path.join(dataDir, "accounts.json"), SIGUO_ROOMS_FILE:path.join(dataDir,'rooms.json'), SIGUO_PICTURES_DIR:path.join(dataDir,'pictures'), SIGUO_AVATARS_DIR:path.join(dataDir,'avatars') },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务器启动超时")), 3000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("已启动")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", reject);
  });
  return child;
}

function api(port, route, options = {}) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json", ...(options.admin ? { "x-admin-key": "admin-test-admin-key-123" } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function createAccount(port, username, type = "human") {
  const r = await api(port, "/api/admin/accounts", { method: "POST", admin: true, body: { username, password: "test1234", accountType: type } });
  assert.equal(r.status, 201, `创建 ${username} 失败`);
}

async function login(port, username) {
  const r = await api(port, "/api/login", { method: "POST", body: { username, password: "test1234" } });
  assert.equal(r.status, 200, `登录 ${username} 失败`);
  return r.body;
}

function waitLobbyChat(socket, predicate) {
  return waitEvent(socket, "lobby-chat", (messages) => predicate(messages || []));
}
function waitGameError(socket, includes) {
  return waitEvent(socket, "game-error", (error) => String(error).includes(includes));
}
function waitRoomState(socket, predicate) {
  return waitEvent(socket, "room-state", predicate);
}

test("管理员账号：创建、大厅召回/禁言/封禁、用户自撤回、不能操作同级", { timeout: 45000 }, async (t) => {
  const port = 32148;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "siguo-junqi-admin-"));
  const child = await startServer(port, dataDir);
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.disconnect();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  await createAccount(port, "AdminA", "admin");
  await createAccount(port, "AdminB", "admin");
  await createAccount(port, "UserA", "human");

  const adminA = await login(port, "AdminA");
  const adminB = await login(port, "AdminB");
  const userA = await login(port, "UserA");
  assert.equal(adminA.admin, true, "AdminA 应为管理员");
  assert.equal(adminB.admin, true, "AdminB 应为管理员");
  assert.equal(userA.admin, false, "UserA 不应是管理员");

  const url = `http://127.0.0.1:${port}`;
  const aA=await connectClient(url);sockets.push(aA);
  {const ready=waitEvent(aA,'moderation-state');aA.emit('lobby-auth',{authToken:adminA.token});await ready;}
  const aB=await connectClient(url);sockets.push(aB);
  {const ready=waitEvent(aB,'moderation-state');aB.emit('lobby-auth',{authToken:adminB.token});await ready;}
  const uA=await connectClient(url);sockets.push(uA);
  {const ready=waitEvent(uA,'moderation-state');uA.emit('lobby-auth',{authToken:userA.token});await ready;}

  // 用户自撤回自己的消息（5 分钟内）
  uA.emit("lobby-chat-message", { text: "你好，我是 UserA", authToken: userA.token });
  const selfMsg = await waitLobbyChat(uA, (m) => m.some((x) => x.name === "UserA" && x.text === "你好，我是 UserA"));
  const selfId = selfMsg.find((x) => x.name === "UserA" && x.text === "你好，我是 UserA").id;
  uA.emit("recall-own", { scope: "lobby", id: selfId });
  const recalledSelf = await waitLobbyChat(uA, (m) => m.find((x) => x.id === selfId)?.recalled === true);
  assert.equal(recalledSelf.find((x) => x.id === selfId).text, "[已撤回]");

  // 用户不能撤回别人的消息
  uA.emit("lobby-chat-message", { text: "AdminB 的草稿", authToken: userA.token });
  const otherMsg = await waitLobbyChat(uA, (m) => m.some((x) => x.text === "AdminB 的草稿"));
  const otherId = otherMsg.find((x) => x.text === "AdminB 的草稿").id;
  aB.emit("recall-own", { scope: "lobby", id: otherId });
  await waitGameError(aB, "只能撤回自己的消息");

  // 管理员撤回普通用户消息
  uA.emit("lobby-chat-message", { text: "待管理员撤回", authToken: userA.token });
  const targetMsg = await waitLobbyChat(uA, (m) => m.some((x) => x.text === "待管理员撤回"));
  const targetId = targetMsg.find((x) => x.text === "待管理员撤回").id;
  aA.emit("lobby-moderate", { action: "recall", id: targetId });
  const adminRecalled = await waitLobbyChat(aA, (m) => m.find((x) => x.id === targetId)?.recalled === true);
  assert.equal(adminRecalled.find((x) => x.id === targetId).text, "[消息已由管理员撤回]");

  // 管理员禁言
  aA.emit("lobby-moderate", { action: "mute", username: "UserA" });
  await waitEvent(aA, "moderation-state", (m) => (m.muted || []).includes("UserA"));
  uA.emit("lobby-chat-message", { text: "被封后发送", authToken: userA.token });
  await waitGameError(uA, "你已被大厅禁言或封禁");

  // 解禁
  aA.emit("lobby-moderate", { action: "unmute", username: "UserA" });
  await waitEvent(aA, "moderation-state", (m) => !(m.muted || []).includes("UserA"));
  // 封禁
  aA.emit("lobby-moderate", { action: "ban", username: "UserA" });
  await waitEvent(aA, "moderation-state", (m) => (m.banned || []).includes("UserA"));
  uA.emit("lobby-chat-message", { text: "被封后发送2", authToken: userA.token });
  await waitGameError(uA, "你已被大厅禁言或封禁");

  // 解除封禁后可再发言
  aA.emit("lobby-moderate", { action: "unban", username: "UserA" });
  await waitEvent(aA, "moderation-state", (m) => !(m.banned || []).includes("UserA"));
  uA.emit("lobby-chat-message", { text: "解封后发言", authToken: userA.token });
  await waitLobbyChat(uA, (m) => m.some((x) => x.name === "UserA" && x.text === "解封后发言"));

  // 管理员不能对同级管理员操作
  aB.emit("lobby-chat-message", { text: "管理员 B 的消息", authToken: adminB.token });
  const adminMsg = await waitLobbyChat(aB, (m) => m.some((x) => x.name === "AdminB" && x.text === "管理员 B 的消息"));
  const adminMsgId = adminMsg.find((x) => x.name === "AdminB" && x.text === "管理员 B 的消息").id;
  aA.emit("lobby-moderate", { action: "recall", id: adminMsgId });
  await waitGameError(aA, "不能撤回管理员的消息");
  aA.emit("lobby-moderate", { action: "mute", username: "AdminB" });
  await waitGameError(aA, "不能对管理员操作");
  aA.emit("lobby-moderate", { action: "ban", username: "AdminB" });
  await waitGameError(aA, "不能封禁管理员");
  assert.equal((await api(port,'/api/admin/accounts/AdminA/admin',{method:'PATCH',token:adminA.token,body:{admin:false}})).status,403);
  const roleChanged=waitEvent(aA,'account-profile');
  assert.equal((await api(port,'/api/admin/accounts/AdminA/admin',{method:'PATCH',admin:true,body:{admin:false}})).status,200);
  assert.equal((await roleChanged).admin,false);
  const denied=waitGameError(aA,'只有管理员');aA.emit('lobby-moderate',{action:'ban',username:'UserA'});await denied;
});

test("房间内：管理员明牌观战、房主不能操作管理员、成员自撤回", { timeout: 45000 }, async (t) => {
  const port = 32150;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "siguo-junqi-adminroom-"));
  const child = await startServer(port, dataDir);
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.disconnect();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  await createAccount(port, "AdminA", "admin");
  await createAccount(port, "AdminB", "admin");
  await createAccount(port, "HostU", "human");
  await createAccount(port, "UserA", "human");
  await createAccount(port, "ViewerX", "human");
  const adminA = await login(port, "AdminA");
  const adminB = await login(port, "AdminB");
  const host = await login(port, "HostU");
  const user = await login(port, "UserA");
  const viewer = await login(port, "ViewerX");

  const url = `http://127.0.0.1:${port}`;
  const hostS = await connectClient(url).then((s) => { sockets.push(s); return s; });
  const userS = await connectClient(url).then((s) => { sockets.push(s); return s; });
  const adminAS = await connectClient(url).then((s) => { sockets.push(s); return s; });
  const adminBS = await connectClient(url).then((s) => { sockets.push(s); return s; });
  const viewerS = await connectClient(url).then((s) => { sockets.push(s); return s; });

  const codePromise = waitEvent(hostS, "session").then((s) => s.code);
  hostS.emit("create-room", { authToken: host.token, capacity: 4, mode: "ffa" });
  const code = await codePromise;

  const userSeatState = waitRoomState(userS, (st) => st.pieces.some((p) => p.owner === "south" && p.type));
  userS.emit("join-room", { code, authToken: user.token });
  await waitEvent(userS, "session");
  userS.emit("take-seat", { seat: "south" });
  await userSeatState;

  const adminStatePromise = waitRoomState(adminAS, (st) => st.code === code && st.spectator === true);
  adminAS.emit("watch-room", { code, authToken: adminA.token });
  const adminState = await adminStatePromise;
  assert.equal(adminState.viewerIsAdmin, true, "管理员应标记 viewerIsAdmin");
  assert.equal(adminState.canToggleAdminReveal, true, "管理员旁观应可开启明牌");
  assert.equal(adminState.adminRevealEnabled, false, "未开启时应隐藏棋子");
  assert.equal(adminState.pieces.length > 0 && adminState.pieces.some((p) => !p.type), true, "管理员未开启明牌时不应看到全部棋子");
  // 手动开启明牌观战
  const adminRevealPromise = waitRoomState(adminAS, (st) => st.adminRevealEnabled === true);
  adminAS.emit("toggle-admin-reveal", { enabled: true });
  const adminRevealed = await adminRevealPromise;
  assert.equal(adminRevealed.pieces.length > 0 && adminRevealed.pieces.every((p) => p.type), true, "开启明牌后管理员应看到全部棋子");

  const viewerStatePromise = waitRoomState(viewerS, (st) => st.code === code && st.spectator === true && st.pieces.some((p) => p.owner === "south"));
  viewerS.emit("watch-room", { code, authToken: viewer.token });
  const viewerState = await viewerStatePromise;
  assert.equal(viewerState.pieces.some((p) => p.owner === "south" && !p.type), true, "普通观战不应看到南方的棋子");

  // 房主不能撤回/禁言管理员
  const adminBJoin = waitEvent(adminBS, "session");
  adminBS.emit("join-room", { code, authToken: adminB.token });
  await adminBJoin;
  const adminRoomMsgPromise = waitRoomState(adminBS, (st) => st.chat.some((m) => m.text === "管理员 B 的房间消息"));
  adminBS.emit("chat-message", { text: "管理员 B 的房间消息", authToken: adminB.token });
  const adminRoomMsg = (await adminRoomMsgPromise).chat.find((m) => m.text === "管理员 B 的房间消息");
  hostS.emit("chat-moderate", { action: "recall", id: adminRoomMsg.id });
  await waitGameError(hostS, "不能撤回管理员的消息");
  hostS.emit("chat-moderate", { action: "mute", username: "AdminB" });
  await waitGameError(hostS, "不能对管理员操作");

  // 房间内成员自撤回
  const userRoomMsgPromise = waitRoomState(userS, (st) => st.chat.some((m) => m.text === "南方的消息"));
  userS.emit("chat-message", { text: "南方的消息", authToken: user.token });
  const userRoomMsg = (await userRoomMsgPromise).chat.find((m) => m.text === "南方的消息");
  userS.emit("recall-own", { scope: "room", id: userRoomMsg.id });
  const recalledState = await waitRoomState(userS, (st) => st.chat.find((m) => m.id === userRoomMsg.id)?.recalled === true);
  const recalled = recalledState.chat.find((m) => m.id === userRoomMsg.id);
  assert.equal(recalled.recalled, true, "成员应能撤回自己的房间消息");
});
