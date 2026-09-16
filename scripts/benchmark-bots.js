// One current engine, paired starting layouts and alternating seats.
// Both sides use the same BOT; budgets A/B can be adjusted for profiling.
// This is a smoke benchmark, not a human rating or a statistically valid win rate.
import { activeSeats, hasLegalMove, validateMove, resolveBattle, revealFlagWhenCommanderDies } from '../server/game.js';
import { botView, observeBotBattle } from '../bots/engine/bot.js';
import { createStrongArmy, chooseStrongMove } from '../bots/engine/search.js';

const setting = (key, fallback, max) => Math.min(max, Math.max(1, Number(process.env[key]) || fallback));
const aMs = setting('BOT_A_MS', 300, 4700), bMs = setting('BOT_B_MS', 300, 4700);
const limit = setting('BOT_MAX_PLIES', 120, 1000), games = setting('BOT_GAMES', 2, 100);
const seats = activeSeats(2), results = [];
let armies;
for (let game = 0; game < games; game++) {
  if (game % 2 === 0) armies = { strong: createStrongArmy('north'), normal: createStrongArmy('south') };
  const aSeat = seats[game % 2], bSeat = seats[1 - game % 2];
  const relocate = (army, seat) => army.map(p => ({ ...p, owner: seat, position: p.position.replace(p.owner, seat), initialPosition: p.position.replace(p.owner, seat) }));
  const room = { phase: 'playing', turn: 'north', mode: 'ffa', activeSeats: seats,
    players: seats.map(seat => ({ seat, isBot: true, eliminated: false })),
    pieces: [...relocate(armies.strong, aSeat), ...relocate(armies.normal, bSeat)] };
  const history = Object.fromEntries(seats.map(s => [s, []]));
  const eliminate = seat => { room.players.find(p => p.seat === seat).eliminated = true; for (const p of room.pieces) if (p.owner === seat) p.position = null; };
  let winner = null, captures = 0, ply = 0, sampledTurns = 0;
  const started = Date.now();
  for (; ply < limit; ply++) {
    const seat = room.turn;
    if (!hasLegalMove(room, seat)) { eliminate(seat); winner = seats.find(s => s !== seat); break; }
    const view = botView(room, seat);
    let move;
    if (seat === aSeat) {
      const result = chooseStrongMove(view, history[seat], { budgetMs: aMs });
      move = result.move;
      if (result.samples) sampledTurns++;
    } else move = chooseStrongMove(view, history[seat], { budgetMs: bMs }).move;
    const judged = move && validateMove(room, seat, move.from, move.to);
    if (!judged?.ok) throw new Error(`Illegal ${seat} move: ${JSON.stringify(move)}`);
    const { attacker: a, defender: d, engineerTurn } = judged;
    a.moved = true; if (engineerTurn) a.revealed = true;
    const outcome = resolveBattle(a, d);
    observeBotBattle(room, a, d, outcome);
    if (d) captures++;
    if (outcome === 'attacker' || outcome === 'both') { revealFlagWhenCommanderDies(room, d); d.position = null; }
    if (outcome === 'defender' || outcome === 'both') { revealFlagWhenCommanderDies(room, a); a.position = null; }
    else a.position = move.to;
    if (outcome === 'attacker' && d?.type === 'flag') { eliminate(d.owner); winner = seat; break; }
    history[seat] = [...history[seat], move].slice(-16);
    room.turn = seats.find(s => s !== seat);
  }
  const result = { game: game + 1, aSeat, result: winner ? winner === aSeat ? 'A-win' : 'B-win' : 'move-limit-unresolved',
    plies: Math.min(limit, ply + 1), battles: captures, sampledTurns, elapsedMs: Date.now() - started };
  results.push(result); console.log(JSON.stringify(result));
}
console.log(JSON.stringify({ aMs, bMs, games, wins: results.filter(r => r.result === 'A-win').length,
  losses: results.filter(r => r.result === 'B-win').length, unresolved: results.filter(r => r.result === 'move-limit-unresolved').length }));
