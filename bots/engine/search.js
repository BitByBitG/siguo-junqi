import { BOARD, PIECE_INFO, createArmy, validateSetup, resolveBattle, sameTeam } from '../../server/game.js';
import { distribution, belief, legalBotMoves, engineerTurnPenalty, botTargets } from './bot.js';

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
