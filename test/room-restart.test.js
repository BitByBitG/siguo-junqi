import { fetch } from './encrypted-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createArmy, BOARD, validateMove } from '../server/game.js';
import os from 'node:os';
import path from 'node:path';
import { io } from './encrypted-client.js';
test('房间、棋子、聊天重启恢复，管理员关闭持久生效', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'junqi-restart-'));
  const url = 'http://127.0.0.1:32159';
  let child; const clients = [];
  const start = () => new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, PORT: '32159', SIGUO_DATA_DIR: dir, SIGUO_ROOMS_FILE:path.join(dir,'rooms.json'), SIGUO_PICTURES_DIR:path.join(dir,'pictures'), SIGUO_AVATARS_DIR:path.join(dir,'avatars'), ADMIN_KEY: 'test-long-key-123' } });
    child.stdout.on('data', text => { if (String(text).includes('已启动')) resolve(); });
    child.once('error', reject);
  });
  const stop = () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  t.after(async () => { clients.forEach(s => s.disconnect()); if (child.exitCode === null) await stop(); await rm(dir, { recursive: true, force: true }); });
  const event = (socket, name, predicate = () => true) => new Promise(resolve => {
    const handler = value => { if (predicate(value)) { socket.off(name, handler); resolve(value); } };
    socket.on(name, handler);
  });
  const call = (route, method = 'GET', body) => fetch(url + route, { method, headers: { 'content-type': 'application/json', 'x-admin-key': 'test-long-key-123' }, body: body && JSON.stringify(body) });
  async function saved(file,predicate=()=>true){for(let i=0;i<100;i++){try{const value=JSON.parse(await readFile(path.join(dir,file),'utf8'));if(predicate(value))return value;}catch{}await new Promise(r=>setTimeout(r,20));}throw Error('存档未更新 '+file);}
  const login = async () => (await (await call('/api/login', 'POST', { username: 'tester', password: 'test1234' })).json()).token;
  const connect = async () => { const s = io(url, { transports: ['websocket'], reconnection: false }); clients.push(s); await event(s, 'connect'); return s; };
  await start();
  for (const route of ['/api/register', '/api/admin/accounts']) {
    assert.equal((await call(route, 'POST', { username: 'a'.repeat(19) + 'b', password: 'test1234' })).status, 400);
    assert.equal((await call(route, 'POST', { username: 'a'.repeat(20), password: 'test1234' })).status, 400);
  }
  assert.equal((await call('/api/admin/accounts', 'POST', { username: 'a'.repeat(16), password: 'test1234' })).status, 201);
  await call('/api/admin/accounts', 'POST', { username: 'tester', password: 'test1234' });
  let s = await connect(); let pending = event(s, 'session');
  s.emit('create-room', { authToken: await login(), capacity: 2 });
  const session = await pending;
  pending = event(s, 'lobby-chat', messages => messages.some(m => m.text === '**大厅** $x^2$'));
  s.emit('lobby-chat-message', { authToken: await login(), text: '**大厅** $x^2$' });
  await pending;
  assert.equal((await saved('lobby-chat.json',m=>m.length>0))[0].text, '**大厅** $x^2$');
  pending = event(s, 'room-state', room => room.chat.length > 0);
  s.emit('chat-message', { text: '**hello**\n$\\frac{1}{2}$\n![](https://example.com/a.png)' });
  await pending;
  const before = (await saved('rooms.json',r=>r.rooms[0]?.chat.length>0)).rooms[0];
  const authToken=await login(),id=before.chat[0].id;
  pending=event(s,'room-state',r=>r.chat[0].reactions?.['👍']?.length===1);
  s.emit('chat-react',{authToken,id,emoji:'👍'});await pending;
  pending=event(s,'room-state',r=>r.chat[0].reactions?.['👍']?.length===0);
  s.emit('chat-react',{authToken,id,emoji:'👍'});await pending;
  pending=event(s,'room-state',r=>r.chatMuted.includes('tester'));
  s.emit('chat-moderate',{action:'mute',username:'tester'});await pending;
  pending=event(s,'game-error',m=>m.includes('禁言'));s.emit('chat-message',{text:'blocked'});await pending;
  pending=event(s,'room-state',r=>r.chat[0].recalled);s.emit('chat-moderate',{action:'recall',id});await pending;
  assert.equal((await fetch(url+'/api/admin/chat')).status,403);
  await call('/api/admin/chat','POST',{action:'mute',username:'tester'});
  pending=event(s,'game-error',m=>m.includes('禁言'));s.emit('lobby-chat-message',{authToken,text:'blocked'});await pending;
  const lobby=(await(await call('/api/admin/chat')).json()).messages;
  await call('/api/admin/chat','POST',{action:'recall',id:lobby[0].id});
  assert.equal((await(await call('/api/admin/chat')).json()).messages[0].recalled,true);
  await stop(); s.disconnect();
  before.phase = 'playing'; before.turn = 'north';
  before.players[0].ready = true;
  before.players.push({ seat: 'south', name: 'opponent', username: 'opponent', token: 'opponent', ready: true, online: false, eliminated: false });
  before.pieces.push(...createArmy('south'));
  await writeFile(path.join(dir, 'rooms.json'), JSON.stringify({ version: 1, rooms: [before] }));
  await start(); s = await connect();
  pending = event(s, 'room-state');
  s.emit('join-room', { code: session.code, authToken: await login() });
  const restored = await pending;
  assert.equal(restored.viewerSeat, 'north');
  assert.equal(restored.chat[0].text, before.chat[0].text);
  const after = JSON.parse(await readFile(path.join(dir, 'rooms.json'), 'utf8')).rooms[0];
  assert.deepEqual(after.pieces, before.pieces);
  assert.equal(restored.phase, 'playing');
  let move;
  for (const piece of before.pieces.filter(p => p.owner === 'north')) {
    for (const node of BOARD.nodes) {
      if (validateMove(before, 'north', piece.position, node.id).ok) { move = { from: piece.position, to: node.id }; break; }
    }
    if (move) break;
  }
  assert.ok(move);
  pending = event(s, 'room-state', room => room.turn === 'south'); s.emit('move', move); await pending;
  const other = await connect(); pending = event(other, 'session');
  other.emit('create-room', { authToken: await login(), capacity: 2 });
  const otherSession = await pending;
  assert.notEqual(otherSession.code, session.code);
  assert.ok(s.connected);
  const left = await new Promise((resolve, reject) => other.timeout(3000).emit('leave-room', (error, reply) => error ? reject(error) : resolve(reply)));
  assert.equal(left.ok, true);
  const empty = (await (await call('/api/rooms')).json()).find(room => room.code === otherSession.code);
  assert.ok(empty);
  assert.equal(empty.players, 0);
  assert.equal(empty.spectators, 0);
  const persistedEmpty = (await saved('rooms.json',r=>r.rooms.some(room=>room.code===otherSession.code&&room.players.length===0))).rooms.find(room => room.code === otherSession.code);
  assert.ok(persistedEmpty);
  assert.equal((await fetch(url + '/room/' + session.code)).status, 200);
  await call('/api/admin/rooms/' + otherSession.code, 'DELETE');
  assert.equal((await fetch(url + '/api/admin/rooms/' + session.code, { method: 'DELETE' })).status, 403);
  pending = event(s, 'room-closed');
  assert.equal((await call('/api/admin/rooms/' + session.code, 'DELETE')).status, 200);
  await pending;
  await stop(); await start();
  assert.deepEqual(await (await call('/api/rooms')).json(), []);
});
