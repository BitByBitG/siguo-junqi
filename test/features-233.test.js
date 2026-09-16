import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fetch,io} from './encrypted-client.js';
import {BOARD,validateMove} from '../server/game.js';
import {ratingClass} from '../public/rating-colors.js';

const wait = (socket,event,predicate=()=>true) => new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.off(event,handler);reject(Error(`timeout ${event}`));},7000);
  function handler(value){if(!predicate(value))return;clearTimeout(timer);socket.off(event,handler);resolve(value);}
  socket.on(event,handler);
});
test('CF boundary colors',()=>{
  const cases=[[1199,'gray'],[1200,'green'],[1399,'green'],[1400,'cyan'],[1600,'blue'],[1900,'violet'],[2100,'orange'],[2399,'orange'],[2400,'red'],[2999,'red'],[3000,'legendary'],[3500,'legendary'],[3999,'legendary'],[4000,'tourist']];
  for(const [rating,color] of cases)assert.equal(ratingClass(rating),color);
});
test('announcements, private layouts, room names and undo over encrypted transport', {timeout:60000}, async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'junqi233-'));
  const port=32233, base=`http://127.0.0.1:${port}`, key='features-test-key-233';
  const child=spawn(process.execPath,['server/server.js'],{env:{...process.env,PORT:String(port),SIGUO_DATA_DIR:dir, SIGUO_ROOMS_FILE:path.join(dir,'rooms.json'), SIGUO_PICTURES_DIR:path.join(dir,'pictures'), SIGUO_AVATARS_DIR:path.join(dir,'avatars'),ADMIN_KEY:key},stdio:['ignore','pipe','pipe']});
  const clients=[];
  t.after(async()=>{for(const c of clients)c.disconnect();await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});await rm(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup')),5000);child.stdout.on('data',b=>{if(b.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>process.stderr.write(b));});
  async function api(route,method='GET',body,token,admin=false){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...(admin?{'x-admin-key':key}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
  const auth=[];
  for(const [username,type] of [['PlayerOne','human'],['PlayerTwo','human'],['AdminOne','admin']]){
    assert.equal((await api('/api/admin/accounts','POST',{username,password:'secret123',accountType:type},null,true)).status,201);
    const logged=await api('/api/login','POST',{username,password:'secret123'});auth.push(logged.body);
    assert.equal(logged.body.rating,1500);assert.equal(logged.body.rank,'军士长');assert.equal(logged.body.rankClass,'cyan');
  }
  assert.equal((await api('/api/announcements')).status,200);
  assert.equal((await api('/api/announcements','POST',{text:'denied'},auth[0].token)).status,403);
  assert.equal((await api('/api/announcements','POST',{text:'**公告** $x^2$'},auth[2].token)).status,200);
  assert.equal((await api('/api/announcements','GET',null,auth[0].token)).body.length,1);
  assert.equal((await api('/api/announcements','POST',{text:'key announcement'},null,true)).status,200);
  const one=io(base,{transports:['websocket'],forceNew:true}),two=io(base,{transports:['websocket'],forceNew:true});clients.push(one,two);
  await Promise.all([wait(one,'connect'),wait(two,'connect')]);
  let pending=wait(one,'room-state');one.emit('create-room',{authToken:auth[0].token,capacity:2,name:'朋友棋局'});let a=await pending;
  assert.equal(a.name,'朋友棋局');const code=a.code;
  pending=wait(two,'room-state');two.emit('join-room',{authToken:auth[1].token,code});let b=await pending;
  if(!b.viewerSeat){pending=wait(two,'room-state',s=>!!s.viewerSeat);two.emit('take-seat',{seat:b.players.find(p=>p.empty).seat});b=await pending;}
  const denied=wait(two,'game-error');two.emit('rename-room',{name:'not host'});assert.match(await denied,/房主/);
  pending=wait(one,'room-state',s=>s.name===code);one.emit('rename-room',{name:''});a=await pending;
  const initial=a.pieces.filter(p=>p.owner===a.viewerSeat).map(p=>[p.type,p.position]).sort();
  for(let i=0;i<3;i++){pending=wait(one,'room-state',s=>s.layouts.length===i+1);one.emit('layout-save',{name:`阵${i}`});a=await pending;}
  const full=wait(one,'game-error');one.emit('layout-save',{name:'fourth'});assert.match(await full,/三个/);
  pending=wait(one,'room-state');one.emit('randomize-setup');await pending;
  pending=wait(one,'room-state');one.emit('layout-load',{index:0});a=await pending;
  assert.deepEqual(a.pieces.filter(p=>p.owner===a.viewerSeat).map(p=>[p.type,p.position]).sort(),initial);
  assert.deepEqual(b.layouts,[]);
  pending=wait(one,'room-state',s=>s.layouts.length===2);one.emit('layout-delete',{index:2});a=await pending;
  pending=wait(one,'room-state',s=>s.players.find(p=>p.seat===s.viewerSeat).ready);one.emit('toggle-ready');await pending;
  pending=wait(two,'room-state',s=>s.players.find(p=>p.seat===s.viewerSeat).ready);two.emit('toggle-ready');await pending;
  pending=wait(one,'room-state',s=>s.phase==='playing');one.emit('start-game');a=await pending;
  function safeMove(state){for(const p of state.pieces.filter(p=>p.owner===state.viewerSeat))for(const n of BOARD.nodes){if(state.pieces.some(p=>p.position===n.id))continue;if(validateMove(state,state.viewerSeat,p.position,n.id).ok)return {from:p.position,to:n.id};}throw Error('no move');}
  const before=structuredClone(a),move=safeMove(a);
  pending=wait(one,'room-state',s=>s.ply===1);one.emit('move',move);a=await pending;assert.equal(a.canUndo,true);
  const wrong=wait(two,'game-error');two.emit('undo-move');assert.match(await wrong,/本人/);
  pending=wait(one,'room-state',s=>s.ply===0);one.emit('undo-move');a=await pending;
  assert.deepEqual(a.pieces,before.pieces);assert.equal(a.turn,before.turn);assert.equal(a.canUndo,false);
  pending=wait(two,'room-state',s=>s.ply===1);one.emit('move',move);b=await pending;
  pending=wait(one,'room-state',s=>s.ply===2);two.emit('move',safeMove(b));a=await pending;assert.equal(a.canUndo,false);
  const late=wait(one,'game-error');one.emit('undo-move');assert.match(await late,/下一步/);
  let attack;
  for(const p of a.pieces.filter(p=>p.owner===a.viewerSeat)) {
    const enemy=a.pieces.find(d=>d.owner!==a.viewerSeat && validateMove(a,a.viewerSeat,p.position,d.position).ok);
    if(enemy){attack={from:p.position,to:enemy.position};break;}
  }
  assert.ok(attack, 'front railway must allow an attack');
  const beforeBattle=structuredClone(a);
  pending=wait(one,'room-state',s=>s.ply===3);one.emit('move',attack);a=await pending;
  assert.equal(a.canUndo,true);assert.ok(a.pieces.length<beforeBattle.pieces.length);
  pending=wait(one,'room-state',s=>s.ply===2);one.emit('undo-move');a=await pending;
  assert.deepEqual(a.pieces,beforeBattle.pieces);assert.deepEqual(a.players,beforeBattle.players);
  // Explicit account saves and announcement flushes must include private presets.
  const stored=JSON.parse(await readFile(path.join(dir,'accounts.json'),'utf8'));
  assert.equal(stored.PlayerOne.layouts.length,2);assert.equal(stored.PlayerTwo.layouts,undefined);
  assert.equal(JSON.parse(await readFile(path.join(dir,'announcements.json'),'utf8')).length,2);
});
