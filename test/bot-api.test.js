import { fetch } from './encrypted-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { io } from './encrypted-client.js';

const base = 'http://127.0.0.1:32149';
function event(socket, name, predicate = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`${name}: ${predicate}`)); }, ms);
    const handler = body => { if (predicate(body)) { clearTimeout(timer); socket.off(name, handler); resolve(body); } };
    socket.on(name, handler);
  });
}
test('参赛 BOT API：账号权限、暗棋、幂等、时限和独立程序双 BOT 对局', { timeout: 35000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'junqi-bot-api-'));
  const children = [], sockets = [];
  t.after(async () => { for (const socket of sockets) socket.disconnect(); await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill('SIGTERM');})));  await rm(dir, { recursive: true, force: true }); });
  const server = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '32149', ADMIN_KEY: 'test-api-key-123', ACCOUNTS_FILE: path.join(dir, 'accounts.json'), SIGUO_ROOMS_FILE:path.join(dir,'rooms.json'), SIGUO_PICTURES_DIR:path.join(dir,'pictures'), SIGUO_AVATARS_DIR:path.join(dir,'avatars') }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(server);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server startup')), 3000); server.stdout.on('data', b => { if (b.toString().includes('已启动')) { clearTimeout(timer); resolve(); } }); server.once('error', reject); });
  async function api(route, { token, method = 'GET', body, admin = false } = {}) {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(admin ? { 'x-admin-key': 'test-api-key-123' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function account(username, accountType) {
    assert.equal((await api('/api/admin/accounts', { method: 'POST', admin: true, body: { username, password: 'test1234', accountType } })).status, 201);
    const login = await api(accountType === 'bot' ? '/api/bot/login' : '/api/login', { method: 'POST', body: { username, password: 'test1234' } });
    assert.equal(login.status, 200); return login.body.token;
  }
  async function connect() { const socket = io(base, { transports: ['websocket'], forceNew: true }); sockets.push(socket); await event(socket, 'connect'); return socket; }
  const hostToken = await account('ApiHost', 'human'), alpha = await account('AlphaBot', 'bot'), beta = await account('BetaBot', 'bot');
  const outsider = await account('OtherBot', 'bot');
  const changedLimit=await api('/api/admin/accounts/AlphaBot/bot-time-limit',{method:'PATCH',admin:true,body:{seconds:8}});
  assert.equal(changedLimit.status,200);assert.equal(changedLimit.body.botTurnLimitMs,8000);
  assert.equal((await api('/api/admin/accounts/ApiHost/bot-time-limit',{method:'PATCH',admin:true,body:{seconds:8}})).status,400);
  assert.equal((await api('/api/bot/session')).status, 401);
  assert.equal((await api('/api/bot/session', { token: hostToken })).status, 403);
  assert.equal((await api('/api/login', { method: 'POST', body: { username: 'AlphaBot', password: 'test1234' } })).status, 200);
  assert.equal((await api('/api/register', { method: 'POST', body: { username: 'PendingBot', password: 'test1234', accountType: 'bot' } })).status, 201);
  assert.equal((await api('/api/bot/login', { method: 'POST', body: { username: 'PendingBot', password: 'test1234' } })).status, 403);
  await api('/api/admin/registrations/PendingBot', { method: 'POST', admin: true, body: { action: 'approve' } });
  assert.equal((await api('/api/bot/login', { method: 'POST', body: { username: 'PendingBot', password: 'test1234' } })).status, 200);
  const host = await connect();
  async function create(capacity = 2, mode = 'ffa') {
    const joined = event(host, 'session'); host.emit('create-room', { authToken: hostToken, capacity, mode });
    const session = await joined;
    const vacated = event(host, 'session', s => s.seat === null); host.emit('leave-seat'); await vacated;
    return session.code;
  }
  let code = await create();
  async function add(username, seat) {
    const added = event(host, 'room-state', r => r.players.some(p => p.name === `BOT · ${username}`));
    host.emit('add-bot', { seat, username }); return added;
  }
  await add('AlphaBot', 'north'); const initial = await add('BetaBot', 'south');
  assert.ok(initial.players.every(p => !p.ready));
  const guest = await connect(); const guestToken = await account('ApiGuest', 'human');
  const guestIn = event(guest, 'session'); guest.emit('join-room', { authToken: guestToken, code }); await guestIn;
  const denied = event(guest, 'game-error', text => text.includes('房主')); guest.emit('add-bot', { username: 'OtherBot', seat: 'north' }); await denied;
  assert.equal((await api(`/api/bot/rooms/${code}`, { token: outsider })).status, 403);
  const read = async token => (await api(`/api/bot/rooms/${code}`, { token })).body;
  let a = await read(alpha), b = await read(beta);
  const action = (state, payload = {}) => ({ assignmentId: state.assignmentId, revision: state.revision, requestId: crypto.randomUUID(), ...payload });
  const post = (token, name, body) => api(`/api/bot/rooms/${code}/${name}`, { token, method: 'POST', body });
  assert.equal(a.viewerSeat, 'north'); assert.equal(a.records.length, 50);
  assert.ok(a.pieces.filter(p => p.owner === 'south').every(p => p.type === null));
  assert.ok(a.records.filter(p => p.owner === 'south').every(p => p.type === null));
  const setup = a.pieces.filter(p => p.owner === 'north').map(p => ({ id: p.id, position: p.position }));
  const bad = action(a, { pieces: setup.map(p => ({ ...p, position: 'north-5-1' })) });
  assert.equal((await post(alpha, 'setup', bad)).status, 400);
  assert.equal((await read(alpha)).revision, a.revision);
  const good = action(a, { pieces: setup });
  const ack = await post(alpha, 'setup', good); assert.equal(ack.status, 200);
  assert.deepEqual((await post(alpha, 'setup', good)).body, ack.body);
  assert.equal((await post(alpha, 'setup', { ...good, pieces: [] })).status, 409);
  assert.equal((await post(outsider, 'ready', action(a, { ready: true }))).status, 403);
  assert.equal((await post(alpha, 'ready', action(a, { assignmentId: b.assignmentId, ready: true }))).status, 409);
  await post(alpha, 'ready', action(await read(alpha), { ready: true }));
  assert.equal((await post(alpha, 'setup', action(a, { pieces: setup }))).status, 409);
  await post(beta, 'ready', action(await read(beta), { ready: true }));
  const start = event(host, 'room-state', r => r.phase === 'playing'); host.emit('start-game'); await start;
  a = await read(alpha); b = await read(beta);
  assert.equal(a.turnLimitMs,8000);assert.equal(a.deadline - a.serverTime > 7000, true);
  const move = a.legalMoves.find(m => !a.pieces.some(p => p.position === m.to)); assert.ok(move);
  const request = action(a, move);
  const moved = await post(alpha, 'move', request); assert.equal(moved.status, 200);
  assert.deepEqual((await post(alpha, 'move', request)).body, moved.body);
  assert.equal((await post(beta, 'move', action(b, move))).status, 409);
  const after = await read(beta);
  assert.equal(after.ply,1);assert.equal(after.noCapturePly,1); // Retries and rejected moves did not count.
  assert.equal((await post(alpha, 'move', action(await read(alpha), move))).status, 400);
  const chatted = event(host, 'room-state', r => r.chat.some(c => c.text === 'clock-test')); host.emit('chat-message', { text: 'clock-test' }); await chatted;
  assert.equal((await read(beta)).revision, after.revision);
  assert.equal((await read(beta)).deadline, after.deadline);
  await event(host, 'room-state', r => r.phase === 'finished', 6000);
  assert.ok((await read(alpha)).records.filter(p => p.owner === 'south').every(p => p.type === null));
  await api('/api/admin/accounts/OtherBot', { method: 'DELETE', admin: true });
  assert.equal((await api('/api/bot/session', { token: outsider })).status, 401);
  const closed = event(host, 'room-closed'); host.emit('close-room'); await closed;

  // Run the delivered single file from an otherwise empty directory, using HTTP only.
  code = await create(); await add('AlphaBot', 'north'); await add('BetaBot', 'south');
  assert.equal((await post(alpha, 'ready', action(await read(alpha), { assignmentId: a.assignmentId, ready: true }))).status, 409);
  await copyFile('bots/siguo-junqi-bot.mjs', path.join(dir, 'siguo-junqi-bot.mjs'));
  const botsReady = event(host, 'room-state', r => r.players.every(p => p.ready), 8000);
  for (const username of ['AlphaBot', 'BetaBot']) {
    const child = spawn(process.execPath, [path.join(dir, 'siguo-junqi-bot.mjs')], { cwd: dir,
      env: { ...process.env, BOT_SERVER: base, BOT_USERNAME: username, BOT_PASSWORD: 'test1234', BOT_THINK_MS: '100' }, stdio: 'ignore' });
    children.push(child);
  }
  await botsReady;
  let seen = new Set();
  const track = r => { if (r.lastMove) seen.add(r.lastMove.from); };
  host.on('room-state', track);
  const twoMoves = event(host, 'room-state', () => seen.size >= 2, 8000);
  host.emit('start-game'); const played = await twoMoves;
  host.off('room-state', track);
  assert.ok(played.pieces.every(p => p.type === null));
  assert.equal(played.players.filter(p => p.isBot).length, 2);
  assert.equal((await api(`/api/admin/rooms/${code}/finish`,{method:'POST',admin:true})).status,200);
  const finalClose = event(host, 'room-closed'); host.emit('close-room'); await finalClose;
  await account('GammaBot', 'bot');
  code = await create(4, 'alliance');
  await add('AlphaBot', 'north'); await add('BetaBot', 'south'); await add('PendingBot', 'east'); await add('GammaBot', 'west');
  const alliance = await read(alpha);
  assert.ok(alliance.records.filter(p => p.owner !== 'north').every(p => p.type === null));
  const otherRoom = event(guest, 'session'); guest.emit('create-room', { authToken: guestToken, capacity: 2 }); await otherRoom;
  const addedAgain = event(guest, 'room-state', r => r.players.filter(p => p.name === 'BOT · AlphaBot').length === 1);
  guest.emit('add-bot', { seat: 'south', username: 'AlphaBot' }); await addedAgain;
  const sessions = (await api('/api/bot/session', { token: alpha })).body;
  assert.equal(sessions.assignments.length, 2);
  const ownSeat = sessions.assignments.find(item => item.code === code);
  const otherSeat = sessions.assignments.find(item => item.code !== code);
  assert.ok(ownSeat && otherSeat);
  assert.equal((await api(`/api/bot/rooms/${code}?assignmentId=${ownSeat.assignmentId}`, { token: alpha })).status, 200);
  assert.equal((await api(`/api/bot/rooms/${otherSeat.code}?assignmentId=${otherSeat.assignmentId}`, { token: alpha })).status, 200);
  assert.equal((await api(`/api/bot/rooms/${code}`, { token: alpha })).status, 200);
  const closeOther = event(guest, 'room-closed'); guest.emit('close-room'); await closeOther;
  const closeAlliance = event(host, 'room-closed'); host.emit('close-room'); await closeAlliance;
  const stored = JSON.parse(await readFile(path.join(dir, 'accounts.json'), 'utf8'));
  assert.equal(stored.AlphaBot.type, 'bot'); assert.equal(stored.ApiHost.type, 'human');
});
