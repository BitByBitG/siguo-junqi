import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  BOARD,
  PIECE_INFO,
  SEAT_NAMES,
  activeSeats,
  createArmy,
  pieceAt,
  publicBoard,
  resolveBattle,
  revealFlagWhenCommanderDies,
  sameTeam,
  validateMove,
  validateSetup,
} from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server, { serveClient: true, transports: ["websocket", "polling"] });
const rooms = new Map();
const sessions = new Map();
const PORT = Number(process.env.PORT || 3000);
const LEGACY_ACCOUNTS_FILE = path.join(__dirname, "../data/accounts.json");
const DATA_DIR = process.env.SIGUO_DATA_DIR || path.join(os.homedir(), ".siguo-junqi");
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(DATA_DIR, "accounts.json");
const ADMIN_KEY = process.env.ADMIN_KEY || "junqi-admin";

function loadAccounts() {
  for (const filename of [ACCOUNTS_FILE, LEGACY_ACCOUNTS_FILE]) {
    try { return JSON.parse(fs.readFileSync(filename, "utf8")); }
    catch {}
  }
  return {};
}

const accounts = Object.assign(Object.create(null), loadAccounts());

function saveAccounts() {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE + ".tmp", JSON.stringify(accounts, null, 2), { mode: 0o600 });
  fs.renameSync(ACCOUNTS_FILE + ".tmp", ACCOUNTS_FILE);
}

if (!fs.existsSync(ACCOUNTS_FILE) && fs.existsSync(LEGACY_ACCOUNTS_FILE)) saveAccounts();

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString("hex") };
}

function cleanUsername(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g, "").slice(0, 20);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "../public")));
app.get("/health", (_request, response) => response.json({ ok: true, rooms: rooms.size }));
app.get("/api/rooms", (_request, response) => response.json(roomSummaries()));
app.post("/api/login", (request, response) => {
  const username = cleanUsername(request.body?.username);
  const account = accounts[username];
  if (!account) return response.status(401).json({ error: "账号或密码错误" });
  const hash = passwordHash(request.body?.password, account.salt).hash;
  if (!crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(account.hash, "hex"))) {
    return response.status(401).json({ error: "账号或密码错误" });
  }
  if (account.status === "pending") return response.status(403).json({ error: "注册申请正在等待管理员审核" });
  const token = randomToken();
  sessions.set(token, { username, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  response.json({ token, username });
});
app.post("/api/logout", (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  sessions.delete(token);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.authToken !== token) continue;
    const room = rooms.get(socket.data.roomCode);
    if (room) {
      const player = room.players.find((item) => item.socketId === socket.id);
      const member = room.spectators.get(socket.id);
      const departedName = player?.name || member?.name;
      const removedSeat = removeMember(room, socket, "退出了登录", room.phase === "playing");
      if (room.phase === "playing" && removedSeat === room.turn) advanceTurn(room);
      transferHostIfNeeded(room, departedName);
      if (!room.players.length && !room.spectators.size) rooms.delete(room.code);
      else emitRoom(room);
    }
    socket.disconnect(true);
  }
  emitLobby();
  res.json({ ok: true });
});
app.get("/api/admin/accounts", (request, response) => {
  if (request.headers["x-admin-key"] !== ADMIN_KEY) return response.status(403).json({ error: "管理密钥错误" });
  response.json(Object.keys(accounts).filter(name => accounts[name].status !== "pending").sort());
});
app.post("/api/admin/accounts", (request, response) => {
  if (request.headers["x-admin-key"] !== ADMIN_KEY) return response.status(403).json({ error: "管理密钥错误" });
  const username = cleanUsername(request.body?.username);
  const password = String(request.body?.password || "");
  if (username.length < 2 || password.length < 6) return response.status(400).json({ error: "账号至少 2 位，密码至少 6 位" });
  if (accounts[username]) return response.status(409).json({ error: "账号已存在" });
  accounts[username] = passwordHash(password);
  saveAccounts();
  response.status(201).json({ username });
});

app.delete("/api/admin/accounts/:username", (request, response) => {
  if (request.headers["x-admin-key"] !== ADMIN_KEY) return response.status(403).json({ error: "管理密钥错误" });
  const username = request.params.username;
  if (!Object.hasOwn(accounts, username)) return response.status(404).json({ error: "账号不存在" });
  const account = accounts[username];
  delete accounts[username];
  try { saveAccounts(); }
  catch { accounts[username] = account; return response.status(500).json({ error: "删除失败，请重试" }); }
  for (const [token, session] of sessions) {
    if (session.username === username) sessions.delete(token);
  }
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.username === username) {
      socket.emit("account-deleted");
      socket.disconnect(true);
    }
  }
  response.json({ username });
});

function validCredentials(username, password) {
  return typeof username === "string" && /^[A-Za-z0-9_\u4e00-\u9fff]{2,20}$/.test(username)
    && typeof password === "string" && password.length >= 6 && password.length <= 64;
}
app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!validCredentials(username, password)) return res.status(400).json({ error: "账号须为 2–20 位中文、字母、数字或下划线；密码须为 6–64 位" });
  if (Object.hasOwn(accounts, username)) return res.status(409).json({ error: "账号已存在或正在审核" });
  accounts[username] = { ...passwordHash(password), status: "pending", createdAt: Date.now() };
  try { saveAccounts(); } catch { delete accounts[username]; return res.status(500).json({ error: "保存失败，请重试" }); }
  res.status(201).json({ message: "申请已提交，管理员通过后即可登录" });
});
app.get("/api/admin/registrations", (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "管理密钥错误" });
  res.json(Object.entries(accounts).filter(([, a]) => a.status === "pending").map(([username, a]) => ({ username, createdAt: a.createdAt })));
});
app.post("/api/admin/registrations/:username", (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "管理密钥错误" });
  const username = req.params.username, previous = accounts[username];
  if (!previous || previous.status !== "pending") return res.status(404).json({ error: "申请不存在或已处理" });
  if (!["approve", "reject"].includes(req.body?.action)) return res.status(400).json({ error: "审核操作无效" });
  if (req.body.action === "approve") accounts[username] = { ...previous, status: "active" };
  else delete accounts[username];
  try { saveAccounts(); } catch { accounts[username] = previous; return res.status(500).json({ error: "保存失败，请重试" }); }
  res.json({ username });
});
app.post("/api/password", (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return res.status(401).json({ error: "请重新登录" });
  const previous = accounts[session.username];
  const { oldPassword, password } = req.body || {};
  if (!previous || previous.status === "pending") return res.status(401).json({ error: "请重新登录" });
  if (!validCredentials(session.username, password) || typeof oldPassword !== "string" || oldPassword.length > 64) return res.status(400).json({ error: "密码须为 6–64 位" });
  if (!crypto.timingSafeEqual(Buffer.from(passwordHash(oldPassword, previous.salt).hash, "hex"), Buffer.from(previous.hash, "hex"))) return res.status(403).json({ error: "原密码错误" });
  accounts[session.username] = { ...previous, ...passwordHash(password) };
  try { saveAccounts(); } catch { accounts[session.username] = previous; return res.status(500).json({ error: "保存失败，请重试" }); }
  for (const [key, value] of sessions) if (value.username === session.username) sessions.delete(key);
  for (const socket of io.sockets.sockets.values()) if (socket.data.username === session.username) { socket.emit("account-deleted"); socket.disconnect(true); }
  res.json({ message: "密码已修改，请使用新密码重新登录" });
});

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let code = "";
    const bytes = crypto.randomBytes(6);
    for (const byte of bytes) code += alphabet[byte % alphabet.length];
    if (!rooms.has(code)) return code;
  }
}

function randomToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function cleanName(value) {
  return String(value || "玩家").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16) || "玩家";
}

function roomSummaries() {
  return [...rooms.values()].map((room) => ({
    code: room.code,
    capacity: room.capacity,
    players: room.players.length,
    spectators: room.spectators.size,
    mode: room.mode,
    phase: room.phase,
    createdAt: room.createdAt,
  })).sort((a, b) => b.createdAt - a.createdAt);
}

function emitLobby() {
  io.emit("room-list", roomSummaries());
}

function authSocket(socket, payload) {
  const token = String(payload?.authToken || "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  socket.data.authToken = token;
  socket.data.username = session.username;
  return session.username;
}

function addLog(room, text, tone = "normal") {
  room.logs.unshift({ id: `${Date.now()}-${Math.random()}`, time: Date.now(), text, tone });
  room.logs = room.logs.slice(0, 60);
}

function makePlayer(seat, name, socket) {
  return {
    seat,
    name: cleanName(name),
    token: randomToken(),
    socketId: socket.id,
    online: true,
    ready: false,
    eliminated: false,
  };
}

function playerForSocket(socket) {
  const code = socket.data.roomCode;
  const room = rooms.get(code);
  if (!room) return {};
  const player = room.players.find((item) => item.socketId === socket.id);
  return { room, player };
}

function serializeRoom(room, viewer) {
  const revealAll = room.phase === "finished";
  const spectator = !viewer?.seat;
  return {
    code: room.code,
    capacity: room.capacity,
    mode: room.mode,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner,
    hostSeat: room.players.find((p) => p.name === room.hostName)?.seat || null,
    hostName: room.hostName,
    viewerName: viewer?.name || null,
    viewerSeat: viewer?.seat || null,
    spectator,
    activeSeats: room.activeSeats,
    lastMove: room.lastMove || null,
    players: room.activeSeats.map((seat) => {
      const player = room.players.find((item) => item.seat === seat);
      return player ? {
        seat,
        name: player.name,
        online: player.online,
        ready: player.ready,
        eliminated: player.eliminated,
        isHost: room.hostName === player.name,
      } : { seat, empty: true };
    }),
    pieces: room.pieces.filter((piece) => piece.position).map((piece) => ({
      id: piece.id,
      owner: piece.owner,
      position: piece.position,
      type: !spectator && (revealAll || piece.owner === viewer?.seat || piece.revealed) ? piece.type : null,
      revealed: piece.revealed,
    })),
    spectators: [...room.spectators.values()].map((member) => ({ name: member.name, isHost: member.name === room.hostName })),
    isHost: viewer?.name === room.hostName,
    logs: spectator ? room.logs : [...(room.privateLogs.get(viewer.seat) || []), ...room.logs]
      .sort((a, b) => b.time - a.time).slice(0, 80),
    chat: room.chat,
  };
}

function emitRoom(room) {
  for (const player of room.players) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit("room-state", serializeRoom(room, player));
  }
  for (const [socketId, member] of room.spectators) io.to(socketId).emit("room-state", serializeRoom(room, member));
  emitLobby();
}

function replyError(socket, message) {
  socket.emit("game-error", message);
}

function joinSocket(socket, room, player) {
  if (player.socketId && player.socketId !== socket.id) {
    io.to(player.socketId).emit("session-replaced");
    io.sockets.sockets.get(player.socketId)?.disconnect(true);
  }
  player.socketId = socket.id;
  player.online = true;
  socket.data.roomCode = room.code;
  socket.data.seat = player.seat;
  socket.join(room.code);
  room.spectators.delete(socket.id);
  socket.data.spectator = false;
  socket.emit("session", { code: room.code, token: player.token, seat: player.seat });
  addLog(room, `${player.name} 已连接`);
  socket.emit("board-meta", publicBoard());
  emitRoom(room);
}

function addPrivateLog(room, seat, text, tone = "battle") {
  const list = room.privateLogs.get(seat) || [];
  list.unshift({ id: `${Date.now()}-${Math.random()}`, time: Date.now(), text, tone, private: true });
  room.privateLogs.set(seat, list.slice(0, 40));
}

function eliminate(room, seat, reason) {
  const player = room.players.find((item) => item.seat === seat);
  if (!player || player.eliminated) return;
  player.eliminated = true;
  for (const piece of room.pieces) {
    if (piece.owner === seat) piece.position = null;
  }
  addLog(room, `${SEAT_NAMES[seat]}${reason}`, "danger");
}

function livingSeats(room) {
  return room.players.filter((player) => !player.eliminated).map((player) => player.seat);
}

function checkWinner(room) {
  const living = livingSeats(room);
  if (room.mode === "alliance") {
    const northSouth = living.filter((seat) => seat === "north" || seat === "south");
    const eastWest = living.filter((seat) => seat === "east" || seat === "west");
    if (!northSouth.length || !eastWest.length) {
      room.phase = "finished";
      room.winner = northSouth.length ? "南北联盟" : "东西联盟";
    }
  } else if (living.length <= 1) {
    room.phase = "finished";
    room.winner = living.length ? SEAT_NAMES[living[0]] : "无人";
  }
  if (room.phase === "finished") addLog(room, `${room.winner}获胜`, "success");
}

function advanceTurn(room) {
  if (room.phase !== "playing") return;
  const currentIndex = room.activeSeats.indexOf(room.turn);
  for (let offset = 1; offset <= room.activeSeats.length; offset += 1) {
    const seat = room.activeSeats[(currentIndex + offset) % room.activeSeats.length];
    const player = room.players.find((item) => item.seat === seat);
    if (player && !player.eliminated) {
      room.turn = seat;
      return;
    }
  }
}

function enterRoom(socket, room, username) {
  socket.data.roomCode = room.code;
  socket.data.spectator = true;
  socket.data.seat = null;
  socket.join(room.code);
  room.spectators.set(socket.id, { name: cleanName(username), socketId: socket.id });
  socket.emit("session", { code: room.code, token: null, seat: null });
  socket.emit("board-meta", publicBoard());
  addLog(room, `${cleanName(username)} 进入了房间`);
  emitRoom(room);
}

function resumeExistingMember(socket, room, username) {
  const name = cleanName(username);
  const player = room.players.find((item) => item.name === name);
  if (player) {
    joinSocket(socket, room, player);
    return true;
  }
  const spectator = [...room.spectators.entries()].find(([, item]) => item.name === name);
  if (!spectator) return false;
  const [oldSocketId] = spectator;
  if (oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    oldSocket?.emit("session-replaced");
    room.spectators.delete(oldSocketId);
    oldSocket?.disconnect(true);
  }
  enterRoom(socket, room, name);
  return true;
}

function isHost(room, socket) {
  return room && cleanName(socket.data.username) === room.hostName;
}

function removeMember(room, socket, reason = "离开了房间", preserveArmy = false) {
  const player = room.players.find((item) => item.socketId === socket.id);
  const removedSeat = player?.seat || null;
  if (player) {
    room.players = room.players.filter((item) => item !== player);
    if (!preserveArmy) {
      room.pieces = room.pieces.filter((piece) => piece.owner !== player.seat);
      room.privateLogs.delete(player.seat);
    }
    addLog(room, `${player.name} ${reason}`);
  } else {
    const member = room.spectators.get(socket.id);
    if (member) addLog(room, `${member.name} ${reason}`);
    room.spectators.delete(socket.id);
  }
  socket.leave(room.code);
  socket.data.roomCode = null;
  socket.data.seat = null;
  socket.data.spectator = false;
  return removedSeat;
}

function transferHostIfNeeded(room, departedName) {
  if (room.hostName !== departedName) return;
  room.hostName = room.players[0]?.name || [...room.spectators.values()][0]?.name || null;
  if (room.hostName) addLog(room, `${room.hostName} 成为房主`);
}

io.on("connection", (socket) => {
  socket.emit("board-meta", publicBoard());
  socket.emit("room-list", roomSummaries());

  socket.on("create-room", (payload = {}) => {
    if (socket.data.roomCode) return replyError(socket, "你已经在房间中");
    const username = authSocket(socket, payload);
    if (!username) return replyError(socket, "请先登录账号");
    const capacity = [2, 3, 4].includes(Number(payload.capacity)) ? Number(payload.capacity) : 4;
    const mode = capacity === 4 && payload.mode === "alliance" ? "alliance" : "ffa";
    const code = randomCode();
    const seats = activeSeats(capacity);
    const player = makePlayer(seats[0], username, socket);
    const room = {
      code,
      capacity,
      mode,
      activeSeats: seats,
      players: [player],
      pieces: createArmy(seats[0]),
      phase: "setup",
      hostName: player.name,
      turn: null,
      winner: null,
      lastMove: null,
      logs: [],
      privateLogs: new Map(),
      chat: [],
      spectators: new Map(),
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    addLog(room, `${player.name} 创建了房间`);
    joinSocket(socket, room, player);
    emitLobby();
  });

  socket.on("join-room", (payload = {}) => {
    const code = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const room = rooms.get(code);
    if (!room) return replyError(socket, "没有找到这个房间");
    const username = authSocket(socket, payload);
    if (!username) return replyError(socket, "请先登录账号");

    if (payload.token) {
      const returning = room.players.find((player) => player.token === payload.token);
      if (returning && returning.name === cleanName(username)) return joinSocket(socket, room, returning);
    }

    if (resumeExistingMember(socket, room, username)) return;
    enterRoom(socket, room, username);
  });

  socket.on("watch-room", (payload = {}) => {
    const username = authSocket(socket, payload);
    if (!username) return replyError(socket, "请先登录账号");
    const code = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const room = rooms.get(code);
    if (!room) return replyError(socket, "没有找到这个房间");
    if (socket.data.roomCode) return replyError(socket, "你已经在房间中");
    if (resumeExistingMember(socket, room, username)) return;
    enterRoom(socket, room, username);
  });

  socket.on("take-seat", ({ seat } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase === "finished") return replyError(socket, "对局已经结束");
    if (!room.activeSeats.includes(seat)) return replyError(socket, "该方向不在本局中");
    if (room.players.some((item) => item.seat === seat)) return replyError(socket, "这个方向已经有人");
    const existing = room.players.find((item) => item.socketId === socket.id);
    const name = existing?.name || room.spectators.get(socket.id)?.name;
    if (!name) return replyError(socket, "你不在这个房间中");
    if (existing) {
      if (room.phase !== "setup") return replyError(socket, "请先离座，再接替其他方向");
      room.pieces = room.pieces.filter((piece) => piece.owner !== existing.seat);
      room.privateLogs.delete(existing.seat);
      existing.seat = seat; existing.ready = false; existing.eliminated = false;
      room.pieces.push(...createArmy(seat));
      socket.data.seat = seat;
      socket.emit("session", { code: room.code, token: existing.token, seat });
    } else {
      if (room.phase === "playing" && !room.pieces.some((piece) => piece.owner === seat && piece.position)) return replyError(socket, "该方向已经退出对局");
      const player = makePlayer(seat, name, socket);
      room.players.push(player);
      if (room.phase === "setup") room.pieces.push(...createArmy(seat));
      joinSocket(socket, room, player);
    }
    addLog(room, `${name} 落座${SEAT_NAMES[seat]}`);
    emitRoom(room);
  });

  socket.on("leave-seat", () => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase === "finished") return replyError(socket, "现在不能离座");
    const name = player.name, seat = player.seat;
    room.players = room.players.filter((item) => item !== player);
    if (room.phase === "setup") {
      room.pieces = room.pieces.filter((piece) => piece.owner !== seat);
      room.privateLogs.delete(seat);
    }
    room.spectators.set(socket.id, { name, socketId: socket.id });
    socket.data.seat = null; socket.data.spectator = true;
    socket.emit("session", { code: room.code, token: null, seat: null });
    addLog(room, `${name} 已离座，${room.phase === "playing" ? SEAT_NAMES[seat] + "棋子原位保留" : "转为观战"}`);
    if (room.phase === "playing" && room.turn === seat) advanceTurn(room);
    emitRoom(room);
  });

  socket.on("kick-member", ({ name } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!isHost(room, socket)) return replyError(socket, "只有房主可以踢人");
    name = cleanName(name);
    if (!name || name === room.hostName) return replyError(socket, "不能踢出房主");
    const player = room.players.find((item) => item.name === name);
    const spectator = [...room.spectators.entries()].find(([, item]) => item.name === name);
    const targetId = player?.socketId || spectator?.[0];
    const target = targetId && io.sockets.sockets.get(targetId);
    if (!player && !target) return replyError(socket, "没有找到这个人");
    let removedSeat = null;
    if (target) {
      removedSeat = removeMember(room, target, "被房主踢出房间", room.phase === "playing");
      target.emit("kicked");
    } else {
      removedSeat = player.seat;
      room.players = room.players.filter((item) => item !== player);
      if (room.phase !== "playing") {
        room.pieces = room.pieces.filter((piece) => piece.owner !== player.seat);
        room.privateLogs.delete(player.seat);
      }
      addLog(room, `${player.name} 被房主踢出房间`);
    }
    if (room.phase === "playing" && removedSeat === room.turn) advanceTurn(room);
    emitRoom(room);
  });

  socket.on("close-room", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!isHost(room, socket)) return replyError(socket, "只有房主可以关闭房间");
    const ids = [...room.players.map((item) => item.socketId), ...room.spectators.keys()].filter(Boolean);
    rooms.delete(room.code);
    for (const id of ids) {
      const target = io.sockets.sockets.get(id);
      if (!target) continue;
      target.emit("room-closed"); target.leave(room.code);
      target.data.roomCode = null; target.data.seat = null; target.data.spectator = false;
    }
    emitLobby();
  });

  socket.on("chat-message", (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find((item) => item.socketId === socket.id);
    const name = player?.name || socket.data.username;
    if (!name) return;
    const text = String(payload.text || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 160);
    if (!text) return;
    room.chat.push({ id: crypto.randomUUID(), name, text, time: Date.now() });
    room.chat = room.chat.slice(-80);
    emitRoom(room);
  });

  socket.on("swap-setup", ({ from, to } = {}) => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "setup" || player.ready) return;
    const a = pieceAt(room.pieces, from);
    const b = pieceAt(room.pieces, to);
    if (!a || !b || a.owner !== player.seat || b.owner !== player.seat) {
      return replyError(socket, "请选择两枚己方棋子交换位置");
    }
    const fromNode = BOARD.byId.get(from);
    const toNode = BOARD.byId.get(to);
    if (!fromNode || !toNode || fromNode.kind === "camp" || toNode.kind === "camp") return;
    [a.position, b.position] = [b.position, a.position];
    player.ready = false;
    emitRoom(room);
  });

  socket.on("randomize-setup", () => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "setup" || player.ready) return;
    room.pieces = room.pieces.filter((piece) => piece.owner !== player.seat);
    room.pieces.push(...createArmy(player.seat));
    emitRoom(room);
  });

  socket.on("toggle-ready", () => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "setup") return;
    if (!player.ready) {
      const result = validateSetup(room.pieces, player.seat);
      if (!result.ok) return replyError(socket, result.message);
    }
    player.ready = !player.ready;
    addLog(room, `${player.name}${player.ready ? "已准备" : "取消准备"}`);
    emitRoom(room);
  });

  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "setup") return;
    if (!isHost(room, socket)) return replyError(socket, "只有房主可以开始对局");
    if (room.players.length !== room.capacity) return replyError(socket, "请等待所有玩家加入");
    if (!room.players.every((item) => item.ready)) return replyError(socket, "仍有玩家没有准备");
    room.phase = "playing";
    room.turn = room.activeSeats[0];
    room.lastMove = null;
    addLog(room, "对局开始", "success");
    emitRoom(room);
  });

  socket.on("move", ({ from, to } = {}) => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || player.eliminated) return;
    const result = validateMove(room, player.seat, from, to);
    if (!result.ok) return replyError(socket, result.message);

    const { attacker, defender, engineerTurn } = result;
    if (engineerTurn) attacker.revealed = true;
    const outcome = resolveBattle(attacker, defender);
    room.lastMove = { from, to, pieceId: outcome === "defender" || outcome === "both" ? null : attacker.id };
    let message = `${SEAT_NAMES[attacker.owner]}移动了一枚棋子`;
    if (outcome === "move") {
      attacker.position = to;
    } else if (outcome === "attacker") {
      revealFlagWhenCommanderDies(room, defender);
      defender.position = null;
      attacker.position = to;
      message = `${SEAT_NAMES[attacker.owner]}进攻${SEAT_NAMES[defender.owner]}，守方棋子被消灭`;
      if (defender.type === "flag") eliminate(room, defender.owner, "军旗被夺，退出对局");
    } else if (outcome === "defender") {
      revealFlagWhenCommanderDies(room, attacker);
      attacker.position = null;
      message = `${SEAT_NAMES[attacker.owner]}进攻${SEAT_NAMES[defender.owner]}，进攻棋子被消灭`;
    } else {
      revealFlagWhenCommanderDies(room, attacker);
      revealFlagWhenCommanderDies(room, defender);
      attacker.position = null;
      defender.position = null;
      message = `${SEAT_NAMES[attacker.owner]}与${SEAT_NAMES[defender.owner]}交战，双方棋子同时阵亡`;
    }
    const attackerName = PIECE_INFO[attacker.type].name;
    const defenderName = defender ? PIECE_INFO[defender.type].name : null;
    addPrivateLog(room, attacker.owner, defender
      ? `你的${attackerName}发起进攻：${outcome === "attacker" ? "胜" : outcome === "defender" ? "阵亡" : "同归于尽"}`
      : `你的${attackerName}从 ${from} 移动到 ${to}`);
    if (defender) addPrivateLog(room, defender.owner,
      `你的${defenderName}遭到进攻：${outcome === "defender" ? "守住" : outcome === "attacker" ? "阵亡" : "同归于尽"}`);
    addLog(room, message, outcome === "move" ? "normal" : "battle");
    if (engineerTurn) addLog(room, `${SEAT_NAMES[attacker.owner]}棋子在铁路转弯，确认为工兵`, "battle");
    checkWinner(room);
    advanceTurn(room);
    emitRoom(room);
  });

  socket.on("resign", () => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "playing" || player.eliminated) return;
    eliminate(room, player.seat, "已认输");
    checkWinner(room);
    if (room.turn === player.seat) advanceTurn(room);
    emitRoom(room);
  });

  socket.on("leave-room", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find((item) => item.socketId === socket.id);
    const member = room.spectators.get(socket.id);
    const departedName = player?.name || member?.name;
    const removedSeat = removeMember(room, socket, "离开了房间", room.phase === "playing");
    if (room.phase === "playing" && removedSeat === room.turn) advanceTurn(room);
    transferHostIfNeeded(room, departedName);
    if (!room.players.length && !room.spectators.size) rooms.delete(room.code);
    else emitRoom(room);
    emitLobby();
  });

  socket.on("disconnect", () => {
    if (socket.data.spectator) {
      const room = rooms.get(socket.data.roomCode);
      room?.spectators.delete(socket.id);
      emitLobby();
      return;
    }
    const { room, player } = playerForSocket(socket);
    if (!room || !player || player.socketId !== socket.id) return;
    player.online = false;
    player.socketId = null;
    addLog(room, `${player.name} 已断开，等待重连`);
    emitRoom(room);
  });
});

setInterval(() => {
  const expiry = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.createdAt < expiry && room.players.every((player) => !player.online)) rooms.delete(code);
  }
  emitLobby();
}, 30 * 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`四国军棋已启动：http://localhost:${PORT}`);
});
