import { BOARD, PIECE_INFO, validateMove, resolveBattle, sameTeam } from '../../server/game.js';

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
