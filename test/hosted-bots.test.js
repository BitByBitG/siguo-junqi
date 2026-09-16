import { fetch } from './encrypted-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { io } from './encrypted-client.js';

function guest(source, state = {}, budgetMs = 150) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../server/program-worker.js', import.meta.url), { workerData: { source, state, budgetMs } });
    const timer = setTimeout(() => { worker.terminate(); reject(Error('watchdog')); }, 3000);
    worker.once('message', value => { clearTimeout(timer); worker.terminate(); resolve(value); });
    worker.once('error', error => { clearTimeout(timer); worker.terminate(); reject(error); });
  });
}
test('托管隔离：无宿主对象、动态构造不能逃逸、无限循环和过大内存被限制', async () => {
  const result = await guest(`function act() { return { globals:[typeof process,typeof require,typeof fetch,typeof WebAssembly], escape:({}).constructor.constructor('return typeof process')() }; }`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { globals: Array(4).fill('undefined'), escape: 'undefined' });
  assert.equal((await guest('function act(){while(true){}}')).ok, false);
  assert.equal((await guest('function act(){return new ArrayBuffer(128*1024*1024)}')).ok, false);
});

function event(socket, name, predicate = () => true, ms = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(Error('waiting ' + name)); }, ms);
    const handler = value => { if (predicate(value)) { clearTimeout(timer); socket.off(name, handler); resolve(value); } };
    socket.on(name, handler);
  });
}
test('网页托管：登录、私有源码、保存持久化、示例布阵与走子、外部互斥和停止', { timeout: 35000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'junqi-hosted-'));
  const server = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, PORT: '32150', ADMIN_KEY: 'hosted-test-key-123', ACCOUNTS_FILE: path.join(dir, 'accounts.json'), SIGUO_ROOMS_FILE:path.join(dir,'rooms.json'), SIGUO_PICTURES_DIR:path.join(dir,'pictures'), SIGUO_AVATARS_DIR:path.join(dir,'avatars'), SIGUO_PROGRAMS_FILE: path.join(dir, 'programs.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let socket;
  t.after(async () => { socket?.disconnect(); await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.once('exit',resolve);server.kill();}); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('startup')), 4000); server.stdout.on('data', b => { if (b.toString().includes('已启动')) { clearTimeout(timer); resolve(); } }); server.once('error', reject); });
  async function api(route, token, method = 'GET', body, admin = false) {
    const response = await fetch('http://127.0.0.1:32150' + route, { method, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token, ...(admin ? { 'x-admin-key': 'hosted-test-key-123' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function account(username, accountType) {
    assert.equal((await api('/api/admin/accounts', null, 'POST', { username, password: 'test1234', accountType }, true)).status, 201);
    const login = await api('/api/login', null, 'POST', { username, password: 'test1234' });
    assert.equal(login.status, 200); assert.equal(login.body.accountType, accountType); return login.body.token;
  }
  const host = await account('Host', 'human'), a = await account('HostedA', 'bot'), b = await account('HostedB', 'bot');
  assert.equal((await api('/api/program')).status, 401);
  assert.equal((await api('/api/program', host)).status, 403);
  assert.equal((await api('/api/program', a, 'PUT', { source: 'while(true){}' })).status, 400);
  const source = await readFile('public/bot-studio-bot.js', 'utf8');
  assert.equal((await api('/api/program', a, 'PUT', { source })).status, 200);
  assert.equal((await api('/api/program', b)).body.source, '');
  assert.equal((await api('/api/program', b, 'PUT', { source })).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'programs.json'))).HostedA.source, source);
  socket = io('http://127.0.0.1:32150', { transports: ['websocket'] });
  await event(socket, 'connect');
  const joined = event(socket, 'session'); socket.emit('create-room', { authToken: host, capacity: 2, mode: 'ffa' });
  const { code } = await joined;
  const left = event(socket, 'session', s => s.seat === null); socket.emit('leave-seat'); await left;
  for (const [username, seat] of [['HostedA', 'north'], ['HostedA', 'south']]) {
    const added = event(socket, 'room-state', s => s.players.some(p => p.name === 'BOT · ' + username));
    socket.emit('add-bot', { username, seat }); await added;
  }
  const ready = event(socket, 'room-state', s => s.players.every(p => p.ready));
  assert.equal((await api('/api/program/run', a, 'POST', { enabled: true })).status, 200);
  await ready;
  const debugState = event(socket, 'room-state', state => state.botDebugEnabled && state.pieces.every(piece => piece.type));
  socket.emit('set-bot-debug', { enabled: true });
  await debugState;
  assert.equal((await api(`/api/bot/rooms/${code}/ready`, a, 'POST', {})).status, 403);
  const moved = event(socket, 'room-state', s => s.phase === 'playing' && !!s.lastMove, 10000);
  socket.emit('start-game'); await moved;
  const programState = (await api('/api/program', a)).body;
  assert.equal(programState.enabled, true);
  assert.equal(programState.assignments.filter(item => item.assignmentId).length, 2);
  const assigned = (await api('/api/bot/session', a)).body.assignments;
  assert.equal(assigned.length, 2);
  assert.equal((await api(`/api/bot/rooms/${code}`, a)).status, 403);
  const north = assigned.find(item => item.seat === 'north');
  const view = (await api(`/api/bot/rooms/${code}?assignmentId=${north.assignmentId}`, a)).body;
  assert.ok(view.pieces.filter(p => p.owner === 'south' && !p.revealed).every(p => p.type === null));
  await api('/api/logout', a, 'POST');
  const again = (await api('/api/login', null, 'POST', { username: 'HostedA', password: 'test1234' })).body.token;
  assert.equal((await api('/api/program', again)).body.enabled, true);
  assert.equal((await api('/api/program/run', again, 'POST', { enabled: false })).status, 200);
  assert.equal((await api('/api/program', again)).body.enabled, false);
  await api('/api/admin/accounts/HostedA', null, 'DELETE', undefined, true);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'programs.json'))).HostedA, undefined);
});
