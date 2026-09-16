import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD, activeSeats, createArmy, validateMove, validateSetup, hasLegalMove } from '../server/game.js';
import { botView, distribution, observeBotBattle, botTargets, belief, engineerTurnPenalty } from '../bots/engine/bot.js';
import { chooseStrongMove, createStrongArmy } from '../bots/engine/search.js';
const createBotArmy = seat => createStrongArmy(seat);
const chooseBotMove = (view, history = [], budgetMs = 150) => chooseStrongMove(view, history, { budgetMs }).move;

test('两处未知本营各半概率藏旗，唯一候选必定进攻', () => {
  const room = { phase: 'playing', turn: 'north', mode: 'ffa', activeSeats: activeSeats(2), pieces: [
    { id: 'a', owner: 'north', type: 'engineer', position: 'south-4-1' },
    { id: 'f', owner: 'south', type: null, position: 'south-5-1' },
    { id: 'g', owner: 'south', type: null, position: 'south-5-3' },
    { id: 'own', owner: 'north', type: 'flag', position: 'north-5-1' },
  ] };
  assert.equal(belief(room, room.pieces[1]).find(([t]) => t === 'flag')[1], .5);
  assert.deepEqual(chooseBotMove(room), { from: 'south-4-1', to: 'south-5-1' });
  room.pieces.splice(2, 1);
  assert.deepEqual(belief(room, room.pieces[1]), [['flag', 1]]);
});

test('工兵拐弯优先后排、确认工兵或排除炸弹的目标', () => {
  const room = { phase: 'playing', turn: 'north', mode: 'ffa', activeSeats: activeSeats(2), pieces: [
    { id: 'a', owner: 'north', type: 'engineer', position: 'north-0-0' },
    { id: 'd', owner: 'south', type: null, position: 'south-0-2' },
  ] };
  const move = { from: 'north-0-0', to: 'south-0-2' };
  assert.equal(validateMove(room, 'north', move.from, move.to).engineerTurn, true);
  assert.equal(engineerTurnPenalty(room, move), 55);
  room.pieces[1].type = 'engineer';
  assert.equal(engineerTurnPenalty(room, move), 0);
  room.pieces[1].type = null; room.pieces[1].candidates = ['platoon', 'mine'];
  assert.equal(engineerTurnPenalty(room, move), 0);
  room.pieces[1].candidates = null; room.pieces[1].position = 'south-4-2';
  assert.equal(engineerTurnPenalty(room, { ...move, to: 'south-4-2' }), 0);
});

test('困毙检查包含本营锁死，普通可移动棋子被围堵也无合法着法', () => {
  const room = { phase: 'playing', turn: 'south', mode: 'ffa', activeSeats: activeSeats(2), pieces: [
    { owner: 'north', type: 'commander', position: 'north-5-1' },
    { owner: 'north', type: 'engineer', position: 'north-5-0' },
    { owner: 'north', type: 'mine', position: 'north-4-0' },
  ] };
  assert.equal(hasLegalMove(room, 'north'), false);
  room.pieces.pop();
  assert.equal(hasLegalMove(room, 'north'), true);
  assert.equal(room.turn, 'south');
});

test('BOT 目标排除出局阵营与空本营，公开旗优先', () => {
  const room = { phase: 'playing', turn: 'north', mode: 'ffa', activeSeats: activeSeats(3), pieces: [
    { id: 'a', owner: 'north', type: 'army', position: 'center-0-0' },
    { id: 'f', owner: 'south', type: 'flag', position: 'south-5-1', revealed: true },
  ] };
  assert.deepEqual(botTargets(botView(room, 'north')).map(n => n.id), ['south-5-1']);
});

test('BOT 布阵合法，2/3/4 人局输出均通过真实走棋校验', () => {
  for (const count of [2, 3, 4]) {
    const seats = activeSeats(count);
    const room = { phase: 'playing', turn: seats[0], mode: count === 4 ? 'alliance' : 'ffa', activeSeats: seats,
      pieces: seats.flatMap(createBotArmy) };
    for (const seat of seats) {
      assert.equal(validateSetup(room.pieces, seat).ok, true);
      room.turn = seat;
      const move = chooseBotMove(botView(room, seat), [], 80);
      assert.ok(move);
      assert.equal(validateMove(room, seat, move.from, move.to).ok, true);
    }
  }
});

test('隐藏棋子交换真实身份和数组顺序不改变 BOT 输入；盟友也不透视', () => {
  const room = { phase: 'playing', turn: 'north', mode: 'alliance', activeSeats: activeSeats(4), pieces: activeSeats(4).flatMap(createArmy) };
  const before = botView(room, 'north');
  for (const p of room.pieces) if (p.owner !== 'north') p.type = 'commander';
  room.pieces.reverse();
  assert.deepEqual(botView(room, 'north'), before);
  assert.ok(before.pieces.filter(p => p.owner !== 'north').every(p => p.type === null));
});

test('BOT 优先夺已知军旗，军旗地雷本营不能移动、不能攻击行营', () => {
  const room = { phase: 'playing', turn: 'north', mode: 'ffa', activeSeats: activeSeats(2), pieces: [
    { id: 'a', owner: 'north', type: 'engineer', position: 'south-4-1' },
    { id: 'f', owner: 'south', type: 'flag', position: 'south-5-1', revealed: true },
    { id: 'own', owner: 'north', type: 'flag', position: 'north-5-1' },
    { id: 'm', owner: 'north', type: 'mine', position: 'north-4-0' },
    { id: 'hq', owner: 'north', type: 'commander', position: 'north-5-3' },
  ] };
  assert.deepEqual(chooseBotMove(botView(room, 'north')), { from: 'south-4-1', to: 'south-5-1' });
  room.pieces = room.pieces.filter(p => p.id !== 'a');
  assert.equal(chooseBotMove(botView(room, 'north')), null);
});

test('BOT 根据自身交战结果推断，不读取敌子名称', () => {
  const room = { players: [{ seat: 'north', isBot: true }] };
  observeBotBattle(room, { owner: 'north', type: 'army' }, { id: 'x', owner: 'south', type: 'commander' }, 'defender');
  const candidates = room.botKnowledge.get('north').get('x');
  assert.ok(candidates.includes('commander'));
  assert.equal(candidates.includes('platoon'), false);
  assert.ok(distribution({ moved: true, position: 'center-0-0' }).every(([t]) => t !== 'mine' && t !== 'flag'));
});
