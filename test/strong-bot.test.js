import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD, PIECE_INFO, activeSeats, createArmy, validateMove, validateSetup, resolveBattle } from '../server/game.js';
import { botView, legalBotMoves } from '../bots/engine/bot.js';
import { inferDomains, samplePosition, strongMoves, simulateStrongMove, chooseStrongMove, createStrongArmy, searchPosition } from '../bots/engine/search.js';

function seeded(seed) { return () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296); }
function roomFor(count) {
  const seats = activeSeats(count);
  const pieces = seats.flatMap(createArmy);
  for (const p of pieces) p.initialPosition = p.position;
  return { phase: 'playing', mode: count === 4 ? 'alliance' : 'ffa', turn: 'north', activeSeats: seats, pieces };
}
const piece = (id, owner, type, position) => ({ id, owner, type, position, revealed: true, moved: type !== 'flag' && type !== 'mine' });
function position(pieces) { return { phase: 'playing', turn: 'north', mode: 'ffa', activeSeats: activeSeats(2), pieces }; }

test('强 BOT 快速走法和真实裁判完全一致，包括随机中盘、转弯铁路和联盟', () => {
  const rng = seeded(81);
  for (const count of [2, 3, 4]) {
    const room = roomFor(count);
    let state = { ...room, occupiedSeats: room.activeSeats, pieces: room.pieces.map(p => ({ ...p, pos: BOARD.nodes.findIndex(n => n.id === p.position) })) };
    for (let ply = 0; ply < 70; ply++) {
      const moves = strongMoves(state);
      if (!moves.length) break;
      const actual = { ...state, phase: 'playing' };
      const key = m => `${m.from}>${m.to}`;
      assert.deepEqual(moves.map(key).sort(), legalBotMoves(actual).map(key).sort());
      const move = moves[Math.floor(rng() * moves.length)];
      const judged = validateMove(actual, state.turn, move.from, move.to);
      assert.ok(judged.ok);
      const outcome = resolveBattle(judged.attacker, judged.defender);
      const next = simulateStrongMove(state, move);
      const at = next.pieces.find(p => p.position === move.to);
      assert.equal(at?.id, outcome === 'both' ? undefined : outcome === 'defender' ? judged.defender.id : judged.attacker.id);
      assert.equal(new Set(next.pieces.map(p => p.position)).size, next.pieces.length);
      state = next;
    }
  }
});

test('暗子抽样遵守完整兵力数量和初始布阵限制', () => {
  const room = roomFor(4), view = botView(room, 'north'), domains = inferDomains(view);
  const rng = seeded(13);
  for (let i = 0; i < 8; i++) {
    const sampled = samplePosition(view, domains, rng);
    assert.ok(sampled);
    for (const seat of room.activeSeats) {
      assert.ok(validateSetup(sampled.pieces, seat).ok);
      for (const [type, info] of Object.entries(PIECE_INFO)) assert.equal(sampled.pieces.filter(p => p.owner === seat && p.type === type).length, info.count);
    }
  }
  const before = botView(room, 'north');
  for (const p of room.pieces) if (p.owner !== 'north') p.type = 'bomb';
  room.pieces.reverse();
  assert.deepEqual(botView(room, 'north'), before);
  assert.deepEqual(samplePosition(before, inferDomains(before), seeded(92)), samplePosition(botView(room, 'north'), inferDomains(before), seeded(92)));
});

test('公开交战约束能交叉推断，阵亡暗子继续占用库存', () => {
  const view = position([
    piece('a', 'north', 'company', null), piece('b', 'north', 'regiment', 'north-0-0'),
    { id: 'x', owner: 'south', type: null, moved: true, initialPosition: 'south-0-0', position: null },
  ]);
  view.records = view.pieces; view.pieces = view.pieces.filter(p => p.position);
  view.battles = [{ attacker: 'x', defender: 'a', outcome: 'attacker' }, { attacker: 'x', defender: 'b', outcome: 'defender' }];
  assert.deepEqual([...inferDomains(view).get('x')], ['battalion']);
  const room = roomFor(2);
  const commander = room.pieces.find(p => p.owner === 'south' && p.type === 'commander');
  commander.position = null; commander.revealed = true;
  const masked = botView(room, 'north');
  const domains = inferDomains(masked);
  assert.ok(masked.records.some(p => p.id === commander.id));
  assert.ok(masked.pieces.filter(p => p.owner === 'south').every(p => !domains.get(p.id).has('commander')));
});

test('强 BOT 夺旗、救旗，并在限时内持续提供合法备选', () => {
  const winning = position([
    piece('a', 'north', 'engineer', 'south-4-1'), piece('f', 'south', 'flag', 'south-5-1'),
    piece('own', 'north', 'flag', 'north-5-1'), piece('enemy', 'south', 'army', 'north-4-1'),
  ]);
  const progress = [];
  const result = chooseStrongMove(botView(winning, 'north'), [], { budgetMs: 350, rng: seeded(3), onProgress: m => progress.push(m) });
  assert.deepEqual(result.move, { from: 'south-4-1', to: 'south-5-1' });
  assert.ok(progress.length >= 1); // certain flag captures intentionally return immediately
  assert.ok(result.elapsedMs < 800);
  for (const m of progress) assert.ok(validateMove(winning, 'north', m.from, m.to).ok);

  const defense = position([
    piece('f', 'north', 'flag', 'north-5-1'), piece('a', 'north', 'commander', 'north-4-0'),
    piece('b', 'north', 'army', 'center-0-0'), piece('x', 'south', 'army', 'north-4-1'),
    piece('bait', 'south', 'platoon', 'center-0-1'), piece('ef', 'south', 'flag', 'south-5-1'),
  ]);
  const rescue = chooseStrongMove(botView(defense, 'north'), [], { budgetMs: 900, rng: seeded(9) });
  assert.deepEqual(rescue.move, { from: 'north-4-0', to: 'north-4-1' });
  const stuck = position([piece('f', 'north', 'flag', 'north-5-1'), piece('a', 'north', 'army', 'north-5-3'), piece('e', 'south', 'flag', 'south-5-1')]);
  assert.equal(chooseStrongMove(botView(stuck, 'north')).move, null);
});

test('搜索到达深度上限时仍识别回吃，避免高估暂时的吃子收益', () => {
  const room = position([
    piece('f', 'north', 'flag', 'north-5-1'), piece('a', 'north', 'army', 'center-0-1'),
    piece('b', 'north', 'platoon', 'north-2-0'), piece('x', 'south', 'commander', 'center-0-2'),
    piece('ef', 'south', 'flag', 'south-5-1'),
  ]);
  const state = { ...room, turn: 'south', occupiedSeats: room.activeSeats,
    lastTarget: BOARD.nodes.findIndex(n => n.id === 'center-0-1'),
    pieces: room.pieces.map(p => ({ ...p, pos: BOARD.nodes.findIndex(n => n.id === p.position) })) };
  const staticScore = searchPosition(state, 'north', 0, -Infinity, Infinity, Date.now() + 1000, 0, 0);
  const tradeScore = searchPosition(state, 'north', 0, -Infinity, Infinity, Date.now() + 1000);
  assert.ok(tradeScore < staticScore - 60, `${tradeScore} should reflect the lost army, unlike ${staticScore}`);
});

test('强 BOT 优化布阵四个方向均合法且保留布局变化', () => {
  const layouts = new Set();
  for (const seat of activeSeats(4)) {
    const army = createStrongArmy(seat, 90);
    assert.ok(validateSetup(army, seat).ok);
    assert.equal(army.filter(p => BOARD.byId.get(p.position).kind === 'hq' && !PIECE_INFO[p.type].immobile).length, 0);
    layouts.add(army.map(p => `${p.type}:${BOARD.byId.get(p.position).row}:${BOARD.byId.get(p.position).col}`).join('|'));
  }
  assert.ok(layouts.size > 1);
});
