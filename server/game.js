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
  if (direct) return { ok: true, attacker, defender };
  if (!rail || !BOARD.railNeighbors.get(to).length) return { ok: false, message: "两点之间没有道路" };
  const reachable = attacker.type === "engineer"
    ? isEngineerRailPath(from, to, room.pieces, activeSeatSet)
    : isStraightRailPath(from, to, room.pieces, activeSeatSet);
  return reachable
    ? { ok: true, attacker, defender }
    : { ok: false, message: attacker.type === "engineer" ? "铁路路线被阻挡" : "只有工兵能在铁路上转弯" };
}

export function sameTeam(a, b) {
  return (a === "north" || a === "south") === (b === "north" || b === "south");
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
