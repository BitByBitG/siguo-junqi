import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fetch,io} from './encrypted-client.js';
import {BOARD} from '../server/game.js';

const event=(socket,name,p=()=>true)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout '+name)),5000);const f=value=>{if(!p(value))return;clearTimeout(timer);socket.off(name,f);resolve(value);};socket.on(name,f);});

test('房主改规则、随机布阵锁定和斗地主抢地主',{timeout:30000},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'junqi-modes-')),port=32294,base=`http://127.0.0.1:${port}`,key='modes-admin-key',sockets=[];
  const child=spawn(process.execPath,['server/server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),ADMIN_KEY:key,SIGUO_DATA_DIR:dir,SIGUO_ROOMS_FILE:path.join(dir,'rooms.json'),SIGUO_PICTURES_DIR:path.join(dir,'pictures'),SIGUO_AVATARS_DIR:path.join(dir,'avatars')},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout')),4000);child.stdout.on('data',d=>{if(String(d).includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',reject);});
  t.after(async()=>{sockets.forEach(s=>s.disconnect());await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill();});await rm(dir,{recursive:true,force:true});});
  async function account(username){await fetch(base+'/api/admin/accounts',{method:'POST',headers:{'content-type':'application/json','x-admin-key':key},body:JSON.stringify({username,password:'test1234'})});return (await(await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'test1234'})})).json()).token;}
  async function connect(){const s=io(base,{transports:['websocket'],forceNew:true});sockets.push(s);await event(s,'connect');return s;}
  const tokens=await Promise.all(['Host294','East294','South294','West294'].map(account)),clients=await Promise.all(tokens.map(()=>connect()));
  let pending=event(clients[0],'room-state');clients[0].emit('create-room',{authToken:tokens[0],capacity:2,mode:'machine_random'});let state=await pending,code=state.code;
  assert.equal(state.mode,'machine_random');assert.equal(state.visibility,'semi');
  assert.equal(state.pieces.length,25);assert.equal(state.pieces.every(p=>BOARD.byId.get(p.position)?.kind!=='camp'),true);
  pending=event(clients[0],'room-state',s=>s.mode==='random');clients[0].emit('configure-room',{name:'随机测试',capacity:4,mode:'random',visibility:'semi'});state=await pending;
  assert.equal(state.capacity,4);assert.equal(state.visibility,'semi');assert.equal(state.players[0].ready,false);
  const denied=event(clients[0],'game-error');clients[0].emit('swap-setup',{from:'north-0-0',to:'north-0-1'});assert.match(await denied,/随机布阵/);
  pending=event(clients[0],'room-state',s=>s.mode==='landlord');clients[0].emit('configure-room',{name:'斗地主测试',capacity:4,mode:'landlord',visibility:'dark'});state=await pending;assert.equal(state.pieces.length,0);
  for(let i=1;i<4;i++){
    let session=event(clients[i],'session');clients[i].emit('join-room',{authToken:tokens[i],code});await session;
    session=event(clients[i],'session',v=>v.seat);clients[i].emit('take-seat',{seat:['east','south','west'][i-1]});await session;
  }
  pending=event(clients[0],'room-state',s=>s.landlordCalling);clients[0].emit('start-game');state=await pending;assert.equal(state.pieces.filter(p=>p.owner==='north').length,20);assert.equal(state.pieces.some(p=>BOARD.byId.get(p.position)?.kind==='camp'),false);
  pending=event(clients[1],'room-state',s=>s.landlordSeat==='east');const hostView=event(clients[0],'room-state',s=>s.landlordSeat==='east');clients[1].emit('claim-landlord');state=await pending;const farmerView=await hostView;
  assert.equal(state.pieces.filter(p=>p.owner==='east').length,39);
  assert.equal(state.pieces.filter(p=>p.owner==='north').length,25);
  assert.equal(state.pieces.some(p=>p.owner==='north'&&p.type==='flag'),false);
  assert.equal(farmerView.pieces.some(p=>p.owner==='east'&&p.type==='flag'),false);
  assert.equal(state.pieces.some(p=>p.owner==='east'&&p.type==='flag'),true);
  const platoon=farmerView.pieces.find(p=>p.owner==='north'&&p.type==='platoon');pending=event(clients[0],'room-state',s=>s.pieces.some(p=>p.id===platoon.id&&p.position==='north-1-1'));clients[0].emit('swap-setup',{from:platoon.position,to:'north-1-1'});await pending;
  for(let i=0;i<4;i++){pending=event(clients[i],'room-state',s=>s.players.find(p=>p.seat===s.viewerSeat)?.ready);clients[i].emit('toggle-ready');await pending;}
  pending=event(clients[0],'room-state',s=>s.phase==='playing');clients[0].emit('start-game');state=await pending;assert.equal(state.mode,'landlord');assert.equal(state.pieces.some(p=>p.owner==='south'&&p.type==='flag'),true);assert.equal(state.pieces.some(p=>p.owner==='east'&&p.type==='flag'),false);
  const locked=event(clients[0],'game-error');clients[0].emit('configure-room',{name:'x',capacity:4,mode:'ffa',visibility:'dark'});assert.match(await locked,/开始对局后/);
  const removed=await fetch(base+'/api/admin/rooms/bulk-delete',{method:'POST',headers:{'content-type':'application/json','x-admin-key':key},body:JSON.stringify({codes:[code]})});
  assert.equal(removed.status,200);assert.equal((await removed.json()).changed,1);
  assert.equal((await(await fetch(base+'/api/rooms')).json()).some(room=>room.code===code),false);
});
