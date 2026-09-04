import crypto from "node:crypto";
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
const PORT = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "../public")));
app.get("/health", (_request, response) => response.json({ ok: true, rooms: rooms.size }));

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

function addLog(room, text, tone = "normal") {
  room.logs.unshift({ id: `${Date.now()}-${Math.random()}`, text, tone });
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
  return {
    code: room.code,
    capacity: room.capacity,
    mode: room.mode,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner,
    hostSeat: room.hostSeat,
    viewerSeat: viewer?.seat || null,
    activeSeats: room.activeSeats,
    players: room.activeSeats.map((seat) => {
      const player = room.players.find((item) => item.seat === seat);
      return player ? {
        seat,
        name: player.name,
        online: player.online,
        ready: player.ready,
        eliminated: player.eliminated,
        isHost: room.hostSeat === seat,
      } : { seat, empty: true };
    }),
    pieces: room.pieces.filter((piece) => piece.position).map((piece) => ({
      id: piece.id,
      owner: piece.owner,
      position: piece.position,
      type: revealAll || piece.owner === viewer?.seat || piece.revealed ? piece.type : null,
      revealed: piece.revealed,
    })),
    logs: room.logs,
  };
}

function emitRoom(room) {
  for (const player of room.players) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit("room-state", serializeRoom(room, player));
  }
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
  socket.emit("session", { code: room.code, token: player.token, seat: player.seat });
  addLog(room, `${player.name} 已连接`);
  socket.emit("board-meta", publicBoard());
  emitRoom(room);
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

io.on("connection", (socket) => {
  socket.emit("board-meta", publicBoard());

  socket.on("create-room", (payload = {}) => {
    if (socket.data.roomCode) return replyError(socket, "你已经在房间中");
    const capacity = [2, 3, 4].includes(Number(payload.capacity)) ? Number(payload.capacity) : 4;
    const mode = capacity === 4 && payload.mode === "alliance" ? "alliance" : "ffa";
    const code = randomCode();
    const seats = activeSeats(capacity);
    const player = makePlayer(seats[0], payload.name, socket);
    const room = {
      code,
      capacity,
      mode,
      activeSeats: seats,
      players: [player],
      pieces: createArmy(seats[0]),
      phase: "setup",
      hostSeat: seats[0],
      turn: null,
      winner: null,
      logs: [],
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    addLog(room, `${player.name} 创建了房间`);
    joinSocket(socket, room, player);
  });

  socket.on("join-room", (payload = {}) => {
    const code = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const room = rooms.get(code);
    if (!room) return replyError(socket, "没有找到这个房间");

    if (payload.token) {
      const returning = room.players.find((player) => player.token === payload.token);
      if (returning) return joinSocket(socket, room, returning);
    }

    if (room.phase !== "setup") return replyError(socket, "对局已经开始，只有原玩家可以重连");
    if (room.players.length >= room.capacity) return replyError(socket, "房间已满");
    const seat = room.activeSeats.find((candidate) => !room.players.some((player) => player.seat === candidate));
    const player = makePlayer(seat, payload.name, socket);
    room.players.push(player);
    room.pieces.push(...createArmy(seat));
    addLog(room, `${player.name} 加入了${SEAT_NAMES[seat]}`);
    joinSocket(socket, room, player);
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
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "setup") return;
    if (player.seat !== room.hostSeat) return replyError(socket, "只有房主可以开始对局");
    if (room.players.length !== room.capacity) return replyError(socket, "请等待所有玩家加入");
    if (!room.players.every((item) => item.ready)) return replyError(socket, "仍有玩家没有准备");
    room.phase = "playing";
    room.turn = room.activeSeats[0];
    addLog(room, "对局开始", "success");
    emitRoom(room);
  });

  socket.on("move", ({ from, to } = {}) => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || player.eliminated) return;
    const result = validateMove(room, player.seat, from, to);
    if (!result.ok) return replyError(socket, result.message);

    const { attacker, defender } = result;
    const outcome = resolveBattle(attacker, defender);
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
    addLog(room, message, outcome === "move" ? "normal" : "battle");
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
    const { room, player } = playerForSocket(socket);
    if (!room || !player) return;
    player.socketId = null;
    player.online = false;
    if (room.phase === "setup") {
      room.players = room.players.filter((item) => item !== player);
      room.pieces = room.pieces.filter((piece) => piece.owner !== player.seat);
      addLog(room, `${player.name} 离开了房间`);
      if (!room.players.length) rooms.delete(room.code);
      else {
        if (room.hostSeat === player.seat) room.hostSeat = room.players[0].seat;
        emitRoom(room);
      }
    } else if (room.phase === "playing" && !player.eliminated) {
      eliminate(room, player.seat, "离开了对局");
      checkWinner(room);
      if (room.turn === player.seat) advanceTurn(room);
      emitRoom(room);
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.seat = null;
  });

  socket.on("disconnect", () => {
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
}, 30 * 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`四国军棋已启动：http://localhost:${PORT}`);
});
