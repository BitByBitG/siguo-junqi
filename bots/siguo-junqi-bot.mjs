// Standalone Junqi BOT; Node.js 18+, no npm dependencies. Generated from this project.
import crypto from "node:crypto";

export const SEATS = ["north", "east", "south", "west"];

export const SEAT_NAMES = {
  north: "北方",
  east: "东方",
  south: "南方",
  west: "西方",
};

export const SEAT_COLORS = {
  north: "#d94b4b",
  east: "#d9a62e",
  south: "#3d78c5",
  west: "#52a565",
};

export const PIECE_INFO = {
  flag: { name: "军旗", rank: 0, count: 1, immobile: true },
  commander: { name: "司令", rank: 9, count: 1 },
  army: { name: "军长", rank: 8, count: 1 },
  division: { name: "师长", rank: 7, count: 2 },
  brigade: { name: "旅长", rank: 6, count: 2 },
  regiment: { name: "团长", rank: 5, count: 2 },
  battalion: { name: "营长", rank: 4, count: 2 },
  company: { name: "连长", rank: 3, count: 3 },
  platoon: { name: "排长", rank: 2, count: 3 },
  engineer: { name: "工兵", rank: 1, count: 3 },
  mine: { name: "地雷", rank: 0, count: 3, immobile: true },
  bomb: { name: "炸弹", rank: 0, count: 2 },
};

const CAMP_CELLS = new Set(["1,1", "1,3", "2,2", "3,1", "3,3"]);
const HQ_CELLS = new Set(["5,1", "5,3"]);

function sectorPosition(seat, row, col) {
  if (seat === "north") return { x: 6 + col, y: 5 - row };
  if (seat === "south") return { x: 10 - col, y: 11 + row };
  if (seat === "west") return { x: 5 - row, y: 10 - col };
  return { x: 11 + row, y: 6 + col };
}

function nodeId(seat, row, col) {
  return `${seat}-${row}-${col}`;
}

function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildBoard() {
  const nodes = [];
  const roads = new Set();
  const rails = new Set();
  const straightRailLines = [];
  const byId = new Map();
  const addEdge = (set, a, b) => set.add(edgeKey(a, b));

  for (const seat of SEATS) {
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const id = nodeId(seat, row, col);
        const key = `${row},${col}`;
        const pos = sectorPosition(seat, row, col);
        const node = {
          id,
          seat,
          row,
          col,
          x: pos.x,
          y: pos.y,
          kind: CAMP_CELLS.has(key) ? "camp" : HQ_CELLS.has(key) ? "hq" : "station",
        };
        nodes.push(node);
        byId.set(id, node);
      }
    }

    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const id = nodeId(seat, row, col);
        if (row + 1 < 6) addEdge(roads, id, nodeId(seat, row + 1, col));
        if (col + 1 < 5) addEdge(roads, id, nodeId(seat, row, col + 1));
        if (CAMP_CELLS.has(`${row},${col}`)) {
          for (const dr of [-1, 1]) {
            for (const dc of [-1, 1]) {
              if (row + dr >= 0 && row + dr < 6 && col + dc >= 0 && col + dc < 5) {
                addEdge(roads, id, nodeId(seat, row + dr, col + dc));
              }
            }
          }
        }
      }
    }

    for (const row of [0, 4]) {
      for (let col = 0; col < 4; col += 1) {
        addEdge(rails, nodeId(seat, row, col), nodeId(seat, row, col + 1));
      }
    }
    for (const col of [0, 4]) {
      for (let row = 0; row < 4; row += 1) {
        addEdge(rails, nodeId(seat, row, col), nodeId(seat, row + 1, col));
      }
    }
    straightRailLines.push(
      Array.from({ length: 5 }, (_, col) => nodeId(seat, 0, col)),
      Array.from({ length: 5 }, (_, col) => nodeId(seat, 4, col)),
      Array.from({ length: 5 }, (_, row) => nodeId(seat, row, 0)),
      Array.from({ length: 5 }, (_, row) => nodeId(seat, row, 4)),
    );
  }

  // 中央保留 3×3 九个铁路点，组成三条南北线和三条东西线。
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const id = `center-${row}-${col}`;
      const node = { id, seat: null, row, col, x: 7 + col, y: 7 + row, kind: "station" };
      nodes.push(node);
      byId.set(id, node);
    }
  }
  const centerLines = [
    [nodeId("north", 0, 0), "center-0-0", "center-1-0", "center-2-0", nodeId("south", 0, 4)],
    [nodeId("north", 0, 2), "center-0-1", "center-1-1", "center-2-1", nodeId("south", 0, 2)],
    [nodeId("north", 0, 4), "center-0-2", "center-1-2", "center-2-2", nodeId("south", 0, 0)],
    [nodeId("west", 0, 4), "center-0-0", "center-0-1", "center-0-2", nodeId("east", 0, 0)],
    [nodeId("west", 0, 2), "center-1-0", "center-1-1", "center-1-2", nodeId("east", 0, 2)],
    [nodeId("west", 0, 0), "center-2-0", "center-2-1", "center-2-2", nodeId("east", 0, 4)],
  ];

  for (const line of centerLines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      addEdge(roads, line[index], line[index + 1]);
      addEdge(rails, line[index], line[index + 1]);
    }
  }
  straightRailLines.push(...centerLines);

  // Opposing edge rails and the matching central rail form one uninterrupted line.
  straightRailLines.push(
    [...Array.from({ length: 5 }, (_, row) => nodeId("north", 4 - row, 0)), ...centerLines[0].slice(1, -1), ...Array.from({ length: 5 }, (_, row) => nodeId("south", row, 4))],
    [...Array.from({ length: 5 }, (_, row) => nodeId("north", 4 - row, 4)), ...centerLines[2].slice(1, -1), ...Array.from({ length: 5 }, (_, row) => nodeId("south", row, 0))],
    [...Array.from({ length: 5 }, (_, row) => nodeId("west", 4 - row, 4)), ...centerLines[3].slice(1, -1), ...Array.from({ length: 5 }, (_, row) => nodeId("east", row, 0))],
    [...Array.from({ length: 5 }, (_, row) => nodeId("west", 4 - row, 0)), ...centerLines[5].slice(1, -1), ...Array.from({ length: 5 }, (_, row) => nodeId("east", row, 4))],
  );

  // 四个角各只有一个弯道；弯道两侧在规则上视为同一条直线铁路。
  const cornerLinks = [];
  for (let index = 0; index < SEATS.length; index += 1) {
    const seat = SEATS[index];
    const leftSeat = SEATS[(index + 1) % SEATS.length];
    cornerLinks.push([nodeId(seat, 0, 4), nodeId(leftSeat, 0, 0)]);
    straightRailLines.push([
      ...Array.from({ length: 5 }, (_, offset) => nodeId(seat, 4 - offset, 4)),
      ...Array.from({ length: 5 }, (_, row) => nodeId(leftSeat, row, 0)),
    ]);
  }

  for (const [a, b] of cornerLinks) {
    addEdge(roads, a, b);
    addEdge(rails, a, b);
  }

  const allEdges = new Set([...roads, ...rails]);
  const neighbors = new Map(nodes.map((node) => [node.id, []]));
  const railNeighbors = new Map(nodes.map((node) => [node.id, []]));
  for (const key of allEdges) {
    const [a, b] = key.split("|");
    neighbors.get(a).push(b);
    neighbors.get(b).push(a);
  }
  for (const key of rails) {
    const [a, b] = key.split("|");
    railNeighbors.get(a).push(b);
    railNeighbors.get(b).push(a);
  }
  return { nodes, byId, roads, rails, neighbors, railNeighbors, straightRailLines };
}

export const BOARD = buildBoard();

export function activeSeats(capacity) {
  if (capacity === 2) return ["north", "south"];
  if (capacity === 3) return ["north", "east", "south"];
  return [...SEATS];
}

function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function createArmy(seat) {
  const types = [];
  for (const [type, info] of Object.entries(PIECE_INFO)) {
    for (let i = 0; i < info.count; i += 1) types.push(type);
  }

  const available = [];
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      if (!CAMP_CELLS.has(`${row},${col}`)) available.push(nodeId(seat, row, col));
    }
  }

  const hqs = shuffled([nodeId(seat, 5, 1), nodeId(seat, 5, 3)]);
  const positions = new Map();
  positions.set("flag", hqs[0]);
  const rear = shuffled(available.filter((id) => {
    const node = BOARD.byId.get(id);
    return node.row >= 4 && id !== hqs[0];
  }));
  for (let i = 0; i < 3; i += 1) positions.set(`mine-${i}`, rear[i]);

  const used = new Set(positions.values());
  const openForBombs = shuffled(available.filter((id) => BOARD.byId.get(id).row > 0 && !used.has(id)));
  for (let i = 0; i < 2; i += 1) {
    positions.set(`bomb-${i}`, openForBombs[i]);
    used.add(openForBombs[i]);
  }

  const open = shuffled(available.filter((id) => !used.has(id)));
  const counters = {};
  const pieces = [];
  let openIndex = 0;
  for (const type of types) {
    const index = counters[type] || 0;
    counters[type] = index + 1;
    const key = type === "flag" ? "flag" : `${type}-${index}`;
    const position = positions.get(key) || open[openIndex++];
    pieces.push({
      id: crypto.randomUUID(),
      owner: seat,
      type,
      position,
      revealed: false,
    });
  }
  return pieces;
}

export function validateSetup(pieces, seat) {
  const own = pieces.filter((piece) => piece.owner === seat && piece.position);
  if (own.length !== 25 || new Set(own.map((piece) => piece.position)).size !== 25) {
    return { ok: false, message: "必须摆放全部 25 枚棋子" };
  }
  for (const piece of own) {
    const node = BOARD.byId.get(piece.position);
    if (!node || node.seat !== seat || node.kind === "camp") {
      return { ok: false, message: "棋子只能放在己方非行营位置" };
    }
    if (piece.type === "flag" && node.kind !== "hq") {
      return { ok: false, message: "军旗必须放在大本营" };
    }
    if (piece.type === "mine" && node.row < 4) {
      return { ok: false, message: "地雷只能放在最后两排" };
    }
    if (piece.type === "bomb" && node.row === 0) {
      return { ok: false, message: "炸弹不能放在第一排" };
    }
  }
  return { ok: true };
}

export function pieceAt(pieces, position) {
  return pieces.find((piece) => piece.position === position) || null;
}

function canEnterNode(position, activeSeatSet) {
  const node = BOARD.byId.get(position);
  return !node?.seat || activeSeatSet.has(node.seat);
}

function isStraightRailPath(from, to, pieces, activeSeatSet) {
  for (const line of BOARD.straightRailLines) {
    const fromIndex = line.indexOf(from);
    const toIndex = line.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) continue;
    const begin = Math.min(fromIndex, toIndex) + 1;
    const end = Math.max(fromIndex, toIndex);
    if (line.slice(begin, end).every((position) => canEnterNode(position, activeSeatSet) && !pieceAt(pieces, position))) return true;
  }
  return false;
}

function isEngineerRailPath(from, to, pieces, activeSeatSet) {
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    if (current === to) return true;
    for (const next of BOARD.railNeighbors.get(current)) {
      if (seen.has(next)) continue;
      if (!canEnterNode(next, activeSeatSet)) continue;
      if (next !== to && pieceAt(pieces, next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

function engineerNeedsTurn(from, to, pieces, activeSeatSet) {
  return !isStraightRailPath(from, to, pieces, activeSeatSet);
}

export function validateMove(room, seat, from, to) {
  if (room.phase !== "playing") return { ok: false, message: "对局尚未开始" };
  if (room.turn !== seat) return { ok: false, message: "还没有轮到你" };
  if (from === to) return { ok: false, message: "请选择另一个位置" };
  const source = BOARD.byId.get(from);
  const target = BOARD.byId.get(to);
  if (!source || !target) return { ok: false, message: "无效位置" };
  const attacker = pieceAt(room.pieces, from);
  const defender = pieceAt(room.pieces, to);
  const activeSeatSet = new Set(room.activeSeats || SEATS);
  if (!attacker || attacker.owner !== seat) return { ok: false, message: "请选择自己的棋子" };
  if (!canEnterNode(to, activeSeatSet)) return { ok: false, message: "不能进入无人阵营" };
  if (PIECE_INFO[attacker.type].immobile || source.kind === "hq") {
    return { ok: false, message: "这枚棋子不能移动" };
  }
  if (defender?.owner === seat) return { ok: false, message: "目标位置已有己方棋子" };
  if (defender && target.kind === "camp") return { ok: false, message: "行营中的棋子不能被攻击" };
  if (defender && room.mode === "alliance" && sameTeam(attacker.owner, defender.owner)) {
    return { ok: false, message: "不能攻击盟友" };
  }

  const direct = BOARD.neighbors.get(from).includes(to);
  const rail = BOARD.rails.has(edgeKey(from, to)) || BOARD.railNeighbors.get(from).length > 0;
  if (direct) return { ok: true, attacker, defender, engineerTurn: false };
  if (!rail || !BOARD.railNeighbors.get(to).length) return { ok: false, message: "两点之间没有道路" };
  const reachable = attacker.type === "engineer"
    ? isEngineerRailPath(from, to, room.pieces, activeSeatSet)
    : isStraightRailPath(from, to, room.pieces, activeSeatSet);
  return reachable
    ? { ok: true, attacker, defender, engineerTurn: attacker.type === "engineer" && engineerNeedsTurn(from, to, room.pieces, activeSeatSet) }
    : { ok: false, message: attacker.type === "engineer" ? "铁路路线被阻挡" : "只有工兵能在铁路上转弯" };
}

export function sameTeam(a, b) {
 
  return (a === "north" || a === "south") === (b === "north" || b === "south");
}

export function hasLegalMove(room, seat) {
  const position = { ...room, phase: "playing", turn: seat };
  return room.pieces.some(p => p.owner === seat && p.position && !PIECE_INFO[p.type].immobile
    && BOARD.nodes.some(n => validateMove(position, seat, p.position, n.id).ok));
}

export function resolveBattle(attacker, defender) {
  if (!defender) return "move";
  if (defender.type === "flag") return "attacker";
  if (attacker.type === "bomb" || defender.type === "bomb") return "both";
  if (defender.type === "mine") return attacker.type === "engineer" ? "attacker" : "defender";
  const a = PIECE_INFO[attacker.type].rank;
  const d = PIECE_INFO[defender.type].rank;
  if (a === d) return "both";
  return a > d ? "attacker" : "defender";
}

export function revealFlagWhenCommanderDies(room, piece) {
  if (!piece || piece.type !== "commander") return;
  const flag = room.pieces.find((item) => item.owner === piece.owner && item.type === "flag" && item.position);
  if (flag) flag.revealed = true;
}

export function publicBoard() {
  return {
    nodes: BOARD.nodes,
    roads: [...BOARD.roads].map((edge) => edge.split("|")),
    rails: [...BOARD.rails].map((edge) => edge.split("|")),
    seatNames: SEAT_NAMES,
    seatColors: SEAT_COLORS,
    pieceNames: Object.fromEntries(Object.entries(PIECE_INFO).map(([key, value]) => [key, value.name])),
  };
}


const TYPES = Object.keys(PIECE_INFO);
const enemy = (view, owner) => owner !== view.turn && !(view.mode === 'alliance' && sameTeam(owner, view.turn));

// This is the ONLY boundary at which the engine can inspect a real room.
// No private logs, hidden ranks, account data or setup-order information cross it.
export function botView(room, seat) {
  const project = p => ({ id: p.id, owner: p.owner, position: p.position,
    type: p.owner === seat || p.revealed ? p.type : null, moved: !!p.moved,
    initialPosition: p.initialPosition || null,
    candidates: room.botKnowledge?.get(seat)?.get(p.id) || null });
  return { phase: room.phase, turn: seat, mode: room.mode, activeSeats: [...room.activeSeats],
    records: room.pieces.map(project).sort((a, b) => a.id.localeCompare(b.id)),
    battles: (room.botBattles || []).map(b => ({ ...b })),
    occupiedSeats: room.players ? room.players.filter(p => !p.eliminated).map(p => p.seat) : [...room.activeSeats],
    livingSeats: room.activeSeats.filter(s => room.pieces.some(p => p.owner === s && p.position)),
    pieces: room.pieces.filter(p => p.position).map(p => ({ id: p.id, owner: p.owner, position: p.position,
      type: p.owner === seat || p.revealed ? p.type : null, moved: !!p.moved,
      initialPosition: p.initialPosition || null,
      candidates: room.botKnowledge?.get(seat)?.get(p.id) || null })).sort((a, b) => a.position.localeCompare(b.position)) };
}

export function observeBotBattle(room, attacker, defender, outcome) {
  if (!defender) return;
  // Public outcome only: exact hidden types must never enter this history.
  room.botBattles ||= [];
  room.botBattles.push({ attacker: attacker.id, defender: defender.id, outcome });
  room.botKnowledge ||= new Map();
  for (const bot of room.players.filter(p => p.isBot)) {
    const ownAttacks = attacker.owner === bot.seat;
    if (!ownAttacks && defender.owner !== bot.seat) continue;
    const unknown = ownAttacks ? defender : attacker;
    const known = ownAttacks ? attacker : defender;
    const memory = room.botKnowledge.get(bot.seat) || new Map();
    const previous = memory.get(unknown.id) || TYPES;
    const remaining = previous.filter(type => resolveBattle(ownAttacks ? known : { type }, ownAttacks ? { type } : known) === outcome);
    memory.set(unknown.id, remaining);
    room.botKnowledge.set(bot.seat, memory);
  }
}


export function distribution(p) {
  if (p.type) return [[p.type, 1]];
  const initial = BOARD.byId.get(p.initialPosition);
  const current = BOARD.byId.get(p.position);
  const possible = TYPES.filter(t => {
    if (p.candidates?.length && !p.candidates.includes(t)) return false;
    if (p.moved && PIECE_INFO[t].immobile) return false;
    if (t === 'flag' && (initial || current)?.kind !== 'hq') return false;
    if (t === 'mine' && initial && initial.row < 4) return false;
    if (t === 'bomb' && initial && initial.row === 0) return false;
    return true;
  });
  const total = possible.reduce((s, t) => s + PIECE_INFO[t].count, 0);
  return possible.map(t => [t, PIECE_INFO[t].count / total]);
}

export function legalBotMoves(view) {
  const moves = [];
  for (const p of view.pieces) {
    if (p.owner !== view.turn || !p.type || PIECE_INFO[p.type].immobile) continue;
    for (const n of BOARD.nodes) if (validateMove(view, view.turn, p.position, n.id).ok) moves.push({ from: p.position, to: n.id });
  }
  return moves;
}

// Exactly one flag per living army: its probability is shared by eligible HQs,
// rather than diluted by the counts of all 25 pieces.
export function belief(view, p) {
  const base = distribution(p);
  if (p.type || !base.some(([t]) => t === 'flag')) return base;
  const knownFlag = view.pieces.some(q => q.owner === p.owner && q.type === 'flag');
  const candidates = view.pieces.filter(q => q.owner === p.owner && !q.type
    && distribution(q).some(([t]) => t === 'flag'));
  const flagProbability = knownFlag ? 0 : 1 / Math.max(1, candidates.length);
  const other = base.filter(([t]) => t !== 'flag');
  const total = other.reduce((s, [, weight]) => s + weight, 0);
  return [['flag', flagProbability], ...other.map(([t, weight]) => [t, (1 - flagProbability) * weight / (total || 1)])].filter(([, weight]) => weight > 0);
}

export function engineerTurnPenalty(view, move) {
  const result = validateMove(view, view.turn, move.from, move.to);
  if (!result.ok || !result.engineerTurn) return 0;
  const d = result.defender;
  if (!d) return 22; // Do not reveal an engineer merely to wander around.
  const node = BOARD.byId.get(d.position);
  const options = belief(view, d);
  if (node.seat === d.owner && node.row >= 4) return 0;
  if (options.every(([t]) => t === 'engineer') || !options.some(([t]) => t === 'bomb')) return 0;
  return 55;
}

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export function botTargets(view) {
  const living = view.livingSeats || view.activeSeats.filter(s => view.pieces.some(p => p.owner === s && p.position));
  const result = [];
  for (const seat of living.filter(s => enemy(view, s))) {
    const flag = view.pieces.find(p => p.owner === seat && p.type === 'flag');
    if (flag) { result.push(BOARD.byId.get(flag.position)); continue; }
    // Empty or already identified headquarters cannot contain the flag.
    for (const p of view.pieces.filter(p => p.owner === seat && !p.type && !p.moved)) {
      const n = BOARD.byId.get(p.position);
      if (n.kind === 'hq' && distribution(p).some(([t]) => t === 'flag')) result.push(n);
    }
    if (!result.some(n => n.seat === seat)) for (const p of view.pieces.filter(p => p.owner === seat)) result.push(BOARD.byId.get(p.position));
  }
  return result;
}


const nodes = BOARD.nodes;
const index = new Map(nodes.map((n, i) => [n.id, i]));
const roads = nodes.map(n => BOARD.neighbors.get(n.id).map(id => index.get(id)));
const rails = nodes.map(n => BOARD.railNeighbors.get(n.id).map(id => index.get(id)));
const lines = BOARD.straightRailLines.map(line => line.map(id => index.get(id)));
const through = nodes.map((_, i) => lines.filter(line => line.includes(i)));
const types = Object.keys(PIECE_INFO);
const values = { flag: 16000, mine: 35, bomb: 65, engineer: 48, platoon: 18, company: 24,
  battalion: 32, regiment: 43, brigade: 57, division: 75, army: 100, commander: 135 };
const TIMEOUT = Symbol('search timeout');
const allied = (mode, a, b) => a === b || (mode === 'alliance' && sameTeam(a, b));
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

// Domains include dead pieces: a captured unknown still consumes one army slot.
// Arc consistency uses public battle outcomes and per-army inventory counts only.
export function inferDomains(view) {
  const records = view.records || view.pieces;
  const domains = new Map(records.map(p => [p.id, new Set(distribution(p).map(([t]) => t))]));
  for (let pass = 0; pass < 30; pass++) {
    let changed = false;
    const reduce = (id, test) => {
      const domain = domains.get(id);
      if (!domain) return;
      const next = [...domain].filter(test);
      // Incomplete legacy history must not crash the game or invent certainty.
      if (next.length && next.length < domain.size) { domains.set(id, new Set(next)); changed = true; }
    };
    for (const battle of view.battles || []) {
      const a = domains.get(battle.attacker), d = domains.get(battle.defender);
      if (!a || !d) continue;
      reduce(battle.attacker, t => [...d].some(u => resolveBattle({ type: t }, { type: u }) === battle.outcome));
      reduce(battle.defender, u => [...domains.get(battle.attacker)].some(t => resolveBattle({ type: t }, { type: u }) === battle.outcome));
    }
    for (const seat of view.activeSeats) {
      const army = records.filter(p => p.owner === seat);
      for (const type of types) {
        const fixed = army.filter(p => domains.get(p.id).size === 1 && domains.get(p.id).has(type));
        const open = army.filter(p => domains.get(p.id).size > 1 && domains.get(p.id).has(type));
        const remaining = PIECE_INFO[type].count - fixed.length;
        if (remaining === 0) for (const p of open) reduce(p.id, t => t !== type);
        if (army.length === 25 && remaining > 0 && remaining === open.length) for (const p of open) reduce(p.id, t => t === type);
      }
    }
    if (!changed) break;
  }
  return domains;
}

export function samplePosition(view, domains, rng = Math.random, deadline = Infinity) {
  const records = view.records || view.pieces;
  const chosen = new Map();
  const counts = new Map(view.activeSeats.map(s => [s, Object.fromEntries(types.map(t => [t, PIECE_INFO[t].count]))]));
  const byId = new Map(records.map(p => [p.id, p]));
  const compatible = (id, type) => (view.battles || []).every(b => {
    if (b.attacker === id && chosen.has(b.defender)) return resolveBattle({ type }, { type: chosen.get(b.defender) }) === b.outcome;
    if (b.defender === id && chosen.has(b.attacker)) return resolveBattle({ type: chosen.get(b.attacker) }, { type }) === b.outcome;
    return true;
  });
  let visits = 0;
  const assign = pending => {
    if (!pending.length) return true;
    if (++visits > 14000 || Date.now() > deadline) return false;
    let pick, options;
    for (const p of pending) {
      const available = [...domains.get(p.id)].filter(t => counts.get(p.owner)[t] > 0 && compatible(p.id, t));
      if (!available.length) return false;
      if (!options || available.length < options.length) { pick = p; options = available; }
    }
    // Randomized weighted order without replacement; always respect inventory.
    const weighted = options.map(t => ({ t, key: -Math.log(Math.max(1e-9, rng())) / counts.get(pick.owner)[t] })).sort((a, b) => a.key - b.key);
    for (const { t } of weighted) {
      chosen.set(pick.id, t); counts.get(pick.owner)[t]--;
      if (assign(pending.filter(p => p !== pick))) return true;
      chosen.delete(pick.id); counts.get(pick.owner)[t]++;
    }
    return false;
  };
  if (!assign(records)) return null;
  return { mode: view.mode, turn: view.turn, activeSeats: view.activeSeats,
    occupiedSeats: view.occupiedSeats || view.activeSeats,
    pieces: view.pieces.map(p => ({ ...p, type: chosen.get(p.id) || byId.get(p.id)?.type, pos: index.get(p.position) })) };
}

function occupancy(state) {
  const board = new Array(nodes.length).fill(null);
  for (const p of state.pieces) board[p.pos] = p;
  return board;
}

// Fast generation follows the same roads, logical straight rails and engineer BFS.
// The server still revalidates the final choice through validateMove.
export function strongMoves(state, seat = state.turn) {
  const board = occupancy(state), allowed = new Set(state.activeSeats), moves = [];
  const enter = i => !nodes[i].seat || allowed.has(nodes[i].seat);
  for (const p of state.pieces) {
    if (p.owner !== seat || PIECE_INFO[p.type].immobile || nodes[p.pos].kind === 'hq') continue;
    const destinations = new Set();
    for (const i of roads[p.pos]) if (enter(i)) destinations.add(i);
    if (p.type === 'engineer') {
      const queue = [p.pos], seen = new Set(queue);
      for (let head = 0; head < queue.length; head++) for (const next of rails[queue[head]]) {
        if (seen.has(next) || !enter(next)) continue;
        seen.add(next); destinations.add(next);
        if (!board[next]) queue.push(next);
      }
    } else {
      for (const line of through[p.pos]) for (const direction of [-1, 1]) {
        for (let j = line.indexOf(p.pos) + direction; j >= 0 && j < line.length; j += direction) {
          const next = line[j];
          if (!enter(next)) break;
          destinations.add(next);
          if (board[next]) break;
        }
      }
    }
    for (const to of destinations) {
      const d = board[to];
      if (d && (allied(state.mode, seat, d.owner) || nodes[to].kind === 'camp')) continue;
      moves.push({ from: nodes[p.pos].id, to: nodes[to].id, src: p.pos, dst: to, attacker: p, defender: d });
    }
  }
  return moves;
}

export function simulateStrongMove(state, move) {
  const a = state.pieces.find(p => p.pos === move.src), d = state.pieces.find(p => p.pos === move.dst);
  const outcome = resolveBattle(a, d);
  const lostFlag = d?.type === 'flag' && outcome === 'attacker' ? d.owner : null;
  const pieces = state.pieces.filter(p => p !== a && p !== d && p.owner !== lostFlag);
  if (outcome === 'attacker' || outcome === 'move') pieces.push({ ...a, pos: move.dst, position: move.to, moved: true });
  if (outcome === 'defender') pieces.push(d);
  // Commander loss exposes the flag in simulated positions too.
  const deadCommanders = [a.type === 'commander' && ['both', 'defender'].includes(outcome) ? a.owner : null,
    d?.type === 'commander' && ['both', 'attacker'].includes(outcome) ? d.owner : null];
  const next = { ...state, lastTarget: move.dst, pieces: pieces.map(p => p.type === 'flag' && deadCommanders.includes(p.owner) ? { ...p, revealed: true } : p) };
  return nextTurn(next);
}

function nextTurn(state) {
  const current = state.activeSeats.indexOf(state.turn);
  for (let i = 1; i <= state.activeSeats.length; i++) {
    const seat = state.activeSeats[(current + i) % state.activeSeats.length];
    if (state.occupiedSeats.includes(seat) && state.pieces.some(p => p.owner === seat)) return { ...state, turn: seat };
  }
  return state;
}

function terminal(state, root) {
  const seats = [...new Set(state.pieces.map(p => p.owner))];
  if (!seats.some(s => allied(state.mode, root, s))) return -50000;
  if (!seats.some(s => !allied(state.mode, root, s))) return 50000;
  return null;
}

function evaluate(state, root) {
  const end = terminal(state, root);
  if (end !== null) return end;
  const flags = state.pieces.filter(p => p.type === 'flag');
  const goals = new Map(state.activeSeats.map(seat => [seat, {
    enemy: flags.filter(f => !allied(state.mode, seat, f.owner)),
    own: flags.filter(f => allied(state.mode, seat, f.owner)),
  }]));
  let score = 0;
  for (const p of state.pieces) {
    const friendly = allied(state.mode, root, p.owner), sign = friendly ? 1 : -1;
    const n = nodes[p.pos];
    let v = values[p.type];
    if (n.kind === 'hq' && !PIECE_INFO[p.type].immobile) v *= .15;
    if (!PIECE_INFO[p.type].immobile && n.kind !== 'hq') {
      if (n.kind === 'camp') v += 7;
      if (rails[p.pos].length) v += p.type === 'engineer' ? 6 : 2;
      const enemyFlags = goals.get(p.owner).enemy;
      if (enemyFlags.length) v += Math.max(0, 16 - Math.min(...enemyFlags.map(f => dist(n, nodes[f.pos])))) * .6;
      const ownFlags = goals.get(p.owner).own;
      if (p.type !== 'bomb' && ownFlags.some(f => dist(n, nodes[f.pos]) <= 2)) v += 3;
    }
    score += sign * v;
  }
  return score;
}

function moveOrder(move, state, goals) {
  const { attacker: a, defender: d } = move;
  let score = 0;
  if (d) {
    const result = resolveBattle(a, d);
    if (result === 'attacker' || result === 'both') score += values[d.type];
    if (result === 'defender' || result === 'both') score -= values[a.type];
    score += 5;
  }
  if (goals.length) score += 2 * (Math.min(...goals.map(f => dist(nodes[move.src], nodes[f.pos]))) - Math.min(...goals.map(f => dist(nodes[move.dst], nodes[f.pos]))));
  if (nodes[move.dst].kind === 'camp') score += 5;
  if (nodes[move.dst].kind === 'hq' && d?.type !== 'flag') score -= values[a.type] * .8;
  return score;
}

function orderedMoves(moves, state) {
  const goals = state.pieces.filter(p => p.type === 'flag' && !allied(state.mode, state.turn, p.owner));
  // Compute expensive positional scores once per move, never inside sort comparisons.
  return moves.map(move => ({ move, score: moveOrder(move, state, goals) }))
    .sort((a, b) => b.score - a.score).map(item => item.move);
}

export function searchPosition(state, root, depth, alpha, beta, deadline, ply = 0, exchanges = 2) {
  if (Date.now() >= deadline) throw TIMEOUT;
  const end = terminal(state, root);
  if (end !== null) return end > 0 ? end - ply : end + ply;
  const moves = strongMoves(state);
  if (!moves.length) return searchPosition(nextTurn({ ...state, pieces: state.pieces.filter(p => p.owner !== state.turn) }), root, depth, alpha, beta, deadline, ply + 1, exchanges);
  const maximize = allied(state.mode, root, state.turn);
  if (depth <= 0) {
    // Resolve a short sequence of recaptures instead of evaluating halfway through
    // a trade. Standing pat is an approximation for declining the exchange.
    const captureFlag = moves.find(m => m.defender?.type === 'flag');
    if (captureFlag) return evaluate(simulateStrongMove(state, captureFlag), root);
    let best = evaluate(state, root);
    if (!exchanges) return best;
    for (const move of orderedMoves(moves.filter(m => m.defender && m.dst === state.lastTarget), state).slice(0, 3)) {
      const score = searchPosition(simulateStrongMove(state, move), root, 0, alpha, beta, deadline, ply + 1, exchanges - 1);
      best = maximize ? Math.max(best, score) : Math.min(best, score);
      if (maximize) alpha = Math.max(alpha, best); else beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  let best = maximize ? -Infinity : Infinity;
  // Selective multi-ply alpha-beta; preserve captures and a broad set of quiet moves.
  const width = depth >= 3 ? 10 : 7;
  for (const move of orderedMoves(moves, state).slice(0, width)) {
    const score = searchPosition(simulateStrongMove(state, move), root, depth - 1, alpha, beta, deadline, ply + 1);
    best = maximize ? Math.max(best, score) : Math.min(best, score);
    if (maximize) alpha = Math.max(alpha, best); else beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

function rootHeuristic(view, move, history) {
  const a = view.pieces.find(p => p.position === move.from), d = view.pieces.find(p => p.position === move.to);
  const from = BOARD.byId.get(move.from), to = BOARD.byId.get(move.to);
  const targets = botTargets(view);
  let score = 0;
  if (d) for (const [type, probability] of belief(view, d)) {
    const result = resolveBattle(a, { type });
    score += probability * ((['attacker', 'both'].includes(result) ? values[type] : 0) - (['defender', 'both'].includes(result) ? values[a.type] : 0));
    // A headquarters attack can end the game. The normal material estimate is
    // too conservative when the defender has a real chance of being the flag.
    if (type === 'flag' && to.kind === 'hq' && ['attacker', 'both'].includes(result)) score += probability * 2400;
  }
  if (d?.type === 'flag') score += 1000000;
  score -= engineerTurnPenalty(view, move);
  // Repeated shuffling gives the opponent free information and tempo.
  score -= history.filter(m => m.from === move.from && m.to === move.to).length * 58;
  score -= history.slice(-8).filter(m => m.from === move.to && m.to === move.from).length * 46;
  const progress = targets.length ? Math.min(...targets.map(n => dist(from, n))) - Math.min(...targets.map(n => dist(to, n))) : 0;
  score += progress * 4;
  if (!d && progress <= 0) score -= 30;
  if (to.kind === 'camp' && from.kind !== 'camp') score += 5;
  if (to.seat && !(view.livingSeats || view.activeSeats).includes(to.seat) && progress <= 0) score -= 10;
  if (!d && nodes[index.get(move.to)].kind === 'hq') score -= values[a.type];
  // Do not abandon the immediate ring around our flag unless removing a threat.
  const ownFlags = view.pieces.filter(p => p.owner === view.turn && p.type === 'flag').map(p => BOARD.byId.get(p.position));
  const threat = d && ownFlags.some(flag => dist(to, flag) <= 1);
  if (threat) score += 1800;
  if(d&&to.seat===view.turn)score+=650;
  const invaders=view.pieces.filter(p=>p.position&&!allied(view.mode,p.owner,view.turn)&&BOARD.byId.get(p.position)?.seat===view.turn);
  if(!d&&invaders.length){
    if(ownFlags.some(flag=>dist(from,flag)<=2&&dist(to,flag)>2))score-=900;
    if(to.seat===view.turn)score+=(Math.min(...invaders.map(p=>dist(from,BOARD.byId.get(p.position))))-Math.min(...invaders.map(p=>dist(to,BOARD.byId.get(p.position)))))*90;
  }
  if (!d && ownFlags.some(flag => dist(from, flag) <= 1 && dist(to, flag) > 1)) score -= 42;
  return score;
}

export function chooseStrongMove(view, history = [], { budgetMs = 4700, rng = Math.random, onProgress = () => {} } = {}) {
  const started = Date.now(), deadline = started + Math.max(1, budgetMs);
  let legal = legalBotMoves(view);
  if (!legal.length) return { move: null, samples: 0, depth: 0 };
  const domains = inferDomains(view);
  const informed = { ...view, pieces: view.pieces.map(p => ({ ...p,
    candidates: [...domains.get(p.id)], type: p.type || (domains.get(p.id).size === 1 ? [...domains.get(p.id)][0] : null) })) };
  const ordered = legal.map(m => ({ ...m, prior: rootHeuristic(informed, m, history) })).sort((a, b) => b.prior - a.prior);
  // Never search past a certain winning capture. This also keeps the BOT from
  // preferring a speculative exchange when an exposed flag is already legal.
  const forcedFlag = ordered.find(move => informed.pieces.find(p => p.position === move.to)?.type === 'flag');
  if (forcedFlag) {
    const move = { from: forcedFlag.from, to: forcedFlag.to };
    onProgress(move);
    return { move, samples: 0, depth: 0, elapsedMs: Date.now() - started };
  }
  let best = ordered[0];
  onProgress({ from: best.from, to: best.to });
  // Immediate certain flag capture may end the game; otherwise allow search to protect our flag.
  const candidates = ordered.slice(0, 28);
  // Keep each mobile piece represented, including quiet defensive alternatives.
  for (const move of ordered) if (!candidates.some(m => m.from === move.from)) candidates.push(move);
  const totals = candidates.map(() => ({ sum: 0, square: 0, worst: Infinity }));
  // These preferences depend on the real position, not a sampled hidden army.
  const adjustments = candidates.map(move => {
    const a = informed.pieces.find(p => p.position === move.from), d = informed.pieces.find(p => p.position === move.to);
    const combat = d ? belief(informed, d).reduce((sum, [type, prob]) => {
      const result = resolveBattle(a, { type });
      return sum + prob * ((['attacker', 'both'].includes(result) ? values[type] : 0) - (['defender', 'both'].includes(result) ? values[a.type] : 0));
    }, 0) : 0;
    return move.prior - combat;
  });
  let samples = 0, maxDepth = 0;
  while (Date.now() < deadline) {
    const sampled = samplePosition(view, domains, rng, Math.min(deadline, Date.now() + 120));
    if (!sampled) { if (Date.now() < deadline - 130 && samples === 0) continue; break; }
    const depth = samples < 4 ? 2 : samples < 12 ? 3 : samples < 32 ? 4 : 5;
    const scores = [];
    try {
      for (const move of candidates) {
        const src = index.get(move.from), dst = index.get(move.to);
        scores.push(searchPosition(simulateStrongMove(sampled, { ...move, src, dst }), view.turn, depth, -Infinity, Infinity, deadline));
      }
    } catch (error) { if (error !== TIMEOUT) throw error; break; }
    // Commit complete batches only: every root move sees the same sampled armies.
    samples++; maxDepth = Math.max(maxDepth, depth + 1);
    let bestScore = -Infinity;
    candidates.forEach((move, i) => {
      const stat = totals[i], value = scores[i];
      stat.sum += value; stat.square += value * value; stat.worst = Math.min(stat.worst, value);
      const mean = stat.sum / samples;
      const spread = Math.sqrt(Math.max(0, stat.square / samples - mean * mean));
      const score = mean - .16 * spread + adjustments[i];
      if (score > bestScore) { bestScore = score; best = move; }
    });
    onProgress({ from: best.from, to: best.to });
    if (samples >= 128) break;
  }
  return { move: { from: best.from, to: best.to }, samples, depth: maxDepth, elapsedMs: Date.now() - started };
}

export function scoreStrongSetup(army, seat) {
  const flag = army.find(p => p.type === 'flag'), flagNode = BOARD.byId.get(flag.position);
  let score = 0;
  for (const p of army) {
    const n = BOARD.byId.get(p.position);
    if (n.kind === 'hq' && !PIECE_INFO[p.type].immobile) score -= values[p.type] * 2;
    if (p.type === 'mine') score += 35 - dist(n, flagNode) * 9;
    if (p.type === 'engineer') {
      score += (n.col === 0 || n.col === 4 ? 15 : 0) + (n.row > 0 && n.row < 5 ? 8 : -10);
      if (n.kind === 'hq') score -= 60;
    }
    if (PIECE_INFO[p.type].rank >= 6) score += n.row < 2 ? 16 : -n.row * 2;
    if (p.type === 'bomb') {
      score += n.row >= 1 && n.row <= 3 ? 12 : -8;
      if (army.some(q => PIECE_INFO[q.type].rank >= 7 && dist(n, BOARD.byId.get(q.position)) <= 1)) score += 12;
    }
  }
  for (const col of [0, 4]) {
    const flank = army.filter(p => BOARD.byId.get(p.position).col === col && BOARD.byId.get(p.position).row < 4);
    if (flank.some(p => PIECE_INFO[p.type].rank >= 6)) score += 18;
    if (flank.some(p => p.type === 'engineer')) score += 14;
  }
  // Leave one capable mobile defender near the flag instead of committing
  // every major piece to the front. Other guards get no duplicate bonus.
  if (army.some(p => PIECE_INFO[p.type].rank >= 5 && BOARD.byId.get(p.position).kind !== 'hq'
    && dist(BOARD.byId.get(p.position), flagNode) <= 2)) score += 36;
  return score;
}

export function createStrongArmy(seat, budgetMs = 120, rng = Math.random) {
  const deadline = Date.now() + budgetMs;
  let best = createArmy(seat), bestScore = scoreStrongSetup(best, seat);
  // Random restarts + legal swaps with cooling; many layouts remain possible.
  for (let restart = 0; restart < 12 && Date.now() < deadline; restart++) {
    let army = createArmy(seat), score = scoreStrongSetup(army, seat);
    for (let i = 0; i < 400 && Date.now() < deadline; i++) {
      const a = army[Math.floor(rng() * army.length)], b = army[Math.floor(rng() * army.length)];
      [a.position, b.position] = [b.position, a.position];
      if (!validateSetup(army, seat).ok) { [a.position, b.position] = [b.position, a.position]; continue; }
      const next = scoreStrongSetup(army, seat), temperature = 10 * (1 - i / 400) + .2;
      if (next >= score || rng() < Math.exp((next - score) / temperature)) score = next;
      else [a.position, b.position] = [b.position, a.position];
      if (score > bestScore) { bestScore = score; best = army.map(p => ({ ...p })); }
    }
  }
  return best;
}

import { webcrypto } from 'node:crypto';
export function createSecureClient(baseUrl){
  const nativeFetch=globalThis.fetch,subtle=webcrypto.subtle;
  let pending;
  const channel=()=>pending||=(async()=>{
    const pair=await subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
    const response=await nativeFetch(baseUrl+'/api/crypto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publicKey:await subtle.exportKey('jwk',pair.publicKey)})});
    const data=await response.json();if(!response.ok)throw Error(data.error);
    const raw=await subtle.decrypt('RSA-OAEP',pair.privateKey,Buffer.from(data.key,'base64'));
    return {id:data.id,key:await subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])};
  })();
  const seal=async value=>{
    const c=await channel(),iv=webcrypto.getRandomValues(new Uint8Array(12));
    const data=await subtle.encrypt({name:'AES-GCM',iv,additionalData:Buffer.from('client-v1')},c.key,Buffer.from(JSON.stringify({...value,time:Date.now(),nonce:webcrypto.randomUUID()})));
    return {id:c.id,iv:Buffer.from(iv).toString('base64'),data:Buffer.from(data).toString('base64')};
  };
  const seen=new Map();
  const open=async packet=>{
    const c=await channel();const data=JSON.parse(Buffer.from(await subtle.decrypt({name:'AES-GCM',iv:Buffer.from(packet.iv,'base64'),additionalData:Buffer.from('server-v1')},c.key,Buffer.from(packet.data,'base64'))));
    if(Math.abs(Date.now()-data.time)>120000||seen.has(data.nonce))throw Error('响应过期或重复');
    for(const [nonce,time]of seen)if(Date.now()-time>120000)seen.delete(nonce);
    seen.set(data.nonce,Date.now());return data.value;
  };
  const request=async(url,options={})=>{
    const target=new URL(url,baseUrl),headers=new Headers(options.headers);
    const packet=await seal({kind:'http',url:target.pathname+target.search,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined,authorization:headers.get('Authorization'),adminKey:headers.get('x-admin-key')});
    const response=await nativeFetch(baseUrl+'/api/secure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(packet),signal:options.signal});
    const data=await response.json();if(!data.iv){pending=undefined;throw Error(data.error||'加密连接失效');}
    return new Response(JSON.stringify(await open(data)),{status:response.status,headers:{'Content-Type':'application/json'}});
  };
  return {fetch:request,seal,open,channel};
}

// Included in reference-bot.mjs by scripts/build-reference-bot.js.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) {
  const result = chooseStrongMove(workerData.view, workerData.history, { budgetMs: workerData.budgetMs,
    onProgress: move => parentPort.postMessage({ kind: 'progress', move }) });
  parentPort.postMessage({ kind: 'done', move: result.move });
} else {
  const baseUrl = (process.env.BOT_SERVER || 'http://localhost:3000').replace(/\/$/, '');
  const encryptedFetch=createSecureClient(baseUrl).fetch;
  const username = process.env.BOT_USERNAME, password = process.env.BOT_PASSWORD, requestedAssignment = process.env.BOT_ASSIGNMENT_ID;
  if (!username || !password) {
    console.error('设置 BOT_SERVER、BOT_USERNAME、BOT_PASSWORD 后运行 node reference-bot.mjs');
    process.exitCode = 1;
  } else {
    let token = null, stopped = false, activeWorker = null, assignment = null, prepared = false, history = [];
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    process.on('SIGINT', () => { stopped = true; activeWorker?.terminate(); });
    process.on('SIGTERM', () => { stopped = true; activeWorker?.terminate(); });
    async function http(route, payload) {
      const response = await encryptedFetch(baseUrl + route, { method: payload ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(3000) });
      const body = await response.json();
      if (!response.ok) { const error = new Error(body.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
      return body;
    }
    async function submit(state, action, payload) {
      const body = { ...payload, assignmentId: state.assignmentId, revision: state.revision, requestId: crypto.randomUUID() };
      try { return await http(`/api/bot/rooms/${state.code}/${action}`, body); }
      catch (error) {
        if (error.status || stopped) throw error;
        // An uncertain network result is retried with the SAME idempotency key.
        return http(`/api/bot/rooms/${state.code}/${action}`, body);
      }
    }
    function think(state, budgetMs) {
      return new Promise(resolve => {
        let best = state.legalMoves[0] || null, done = false;
        const worker = new Worker(new URL(import.meta.url), { workerData: { view: state, history, budgetMs } });
        activeWorker = worker;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); worker.terminate(); activeWorker = null; resolve(best); };
        const timer = setTimeout(finish, budgetMs + 60);
        worker.on('message', message => {
          if (state.legalMoves.some(m => m.from === message.move?.from && m.to === message.move?.to)) best = message.move;
          if (message.kind === 'done') finish();
        });
        worker.once('error', finish); worker.once('exit', finish);
      });
    }
    console.log(`BOT ${username} 等待房主分配座位`);
    while (!stopped) {
      try {
        if (!token) {
          token = (await http('/api/bot/login', { username, password })).token;
          const meta = await http('/api/bot/board');
          if (meta.ruleset !== 'siguo-custom-v1') throw new Error('此程序不支持服务器的棋盘规则');
        }
        const session = await http('/api/bot/session');
        const options = session.assignments || (session.assignment ? [session.assignment] : []);
        const selected = requestedAssignment ? options.find(item => item.assignmentId === requestedAssignment) : options[0];
        if (!selected) { assignment = null; console.log(options.length > 1 ? '该账号有多个座位；设置 BOT_ASSIGNMENT_ID 选择其中一个' : '等待房主分配座位'); await delay(500); continue; }
        if (assignment !== selected.assignmentId) {
          assignment = selected.assignmentId; prepared = false; history = [];
          console.log(`已落座 ${selected.code} / ${selected.seat}`);
        }
        let state = await http(`/api/bot/rooms/${selected.code}?assignmentId=${encodeURIComponent(selected.assignmentId)}`);
        if (state.phase === 'setup' && !state.ready) {
          if (!prepared) {
            const army = createStrongArmy(state.viewerSeat);
            const own = state.pieces.filter(p => p.owner === state.viewerSeat);
            const slots = new Map(Object.keys(PIECE_INFO).map(t => [t, army.filter(p => p.type === t).map(p => p.position)]));
            const pieces = own.map(p => ({ id: p.id, position: slots.get(p.type).pop() }));
            await submit(state, 'setup', { pieces }); prepared = true;
            state = await http(`/api/bot/rooms/${state.code}?assignmentId=${encodeURIComponent(state.assignmentId)}`);
          }
          await submit(state, 'ready', { ready: true }); console.log('布阵完成，已准备');
        } else if (state.phase === 'playing' && state.turn === state.viewerSeat && !state.eliminated && state.legalMoves.length) {
          const remaining = state.deadline - state.serverTime;
          const configured = Number(process.env.BOT_THINK_MS) || 3800;
          const budgetMs = Math.max(1, Math.min(4000, configured, remaining - 700));
          const move = remaining < 300 ? state.legalMoves[0] : await think(state, budgetMs);
          if (stopped) break;
          await submit(state, 'move', move);
          history = [...history, move].slice(-16);
          console.log(`${move.from} → ${move.to}`);
        }
        await delay(200);
      } catch (error) {
        if (error.status === 401) token = null;
        if (!stopped) console.error(error.message);
        await delay(error.status === 409 || error.status === 403 ? 300 : 1000);
      }
    }
  }
}
