import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createArmy,activeSeats} from '../server/game.js';
import {initDrawCounters,recordBotActivity,autoDrawReason} from '../server/bot-activity.js';
import {fetch as secureFetch,io} from './encrypted-client.js';

test('global 16-ply draw, casualty reset, human-only exclusion and fixed starting roster',()=>{
 for(const capacity of [2,3,4]){
  const room={capacity,players:[{isBot:true},{isBot:false}],phase:'playing',ply:0};initDrawCounters(room);
  for(let i=1;i<=15;i++){room.ply++;recordBotActivity(room);assert.equal(autoDrawReason(room),null);}
  room.ply++;recordBotActivity(room);assert.equal(autoDrawReason(room),'no-capture');
  recordBotActivity(room,true);assert.equal(room.noCapturePly,0);assert.equal(autoDrawReason(room),null);
  room.players=[];room.ply=capacity*128-1;assert.equal(autoDrawReason(room),null);
  room.ply++;assert.equal(autoDrawReason(room),'move-limit');
  room.phase='finished';assert.equal(autoDrawReason(room),null);
 }
 const human={capacity:2,players:[{},{}],phase:'playing',ply:1000,noCapturePly:1000};initDrawCounters(human);assert.equal(autoDrawReason(human),null);
 const legacy={capacity:2,players:[{isBot:true}],replay:{logs:[{kind:'move',outcome:'both',defender:{}},{kind:'move',outcome:'move'},{text:'聊天'},{kind:'move',outcome:'move'}]},botQuietMoves:{north:4}};initDrawCounters(legacy);assert.equal(legacy.noCapturePly,2);assert.equal('botQuietMoves' in legacy,false);
});

const event=(s,name,p=()=>true)=>new Promise((resolve,reject)=>{const error=Error('timeout '+name),t=setTimeout(()=>{s.off(name,f);reject(error);},5000);function f(v){if(p(v)){clearTimeout(t);s.off(name,f);resolve(v);}}s.on(name,f);});
test('real move boundaries, wins before draws, undo and restart preserve counters',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'junqi-auto-draw-')),base='http://127.0.0.1:32258',key='auto-draw-test-key',file=path.join(dir,'rooms.json'),sockets=[];let child;
 const fixtures=[];
 function fixture(code,capacity,{bot=true,ply=0,quiet=15,battle=null}={}){
  const seats=activeSeats(capacity),players=seats.map((seat,i)=>({seat,name:i?'Other':'Host',username:i?'Other':'Host',token:code+seat,isBot:bot&&i===seats.length-1,ready:true,eliminated:false}));
  const pieces=seats.flatMap(createArmy);
  if(battle){pieces.find(p=>p.position==='north-0-1').position=null;const attacker=pieces.find(p=>p.position==='north-0-0');attacker.type=battle==='loss'?'platoon':'commander';const defender=pieces.find(p=>p.owner===seats[1]&&(battle==='flag'?p.type==='flag':p.position));defender.position='north-0-1';defender.type=battle==='flag'?'flag':battle==='both'?'bomb':battle==='loss'?'commander':'platoon';}
  const r={code,capacity,players,pieces,activeSeats:seats,mode:'ffa',phase:'playing',hostName:'Host',turn:'north',ply,noCapturePly:quiet,keepRoomHistory:true,createdAt:Date.now(),chat:[],logs:[],privateLogs:[],eliminationOrder:[],rated:false,replay:{frames:[],logs:[]}};
  fixtures.push(r);return r;
 }
 fixture('QUIET1',2);fixture('HUMAN1',2,{bot:false});
 for(const n of [2,3,4])fixture('LIMIT'+n,n,{ply:n*128-1,quiet:0});
 for(const [id,battle]of [['CAPTUR','win'],['LOSING','loss'],['BOMBED','both'],['FLAG01','flag']])fixture(id,2,{battle,ply:battle==='flag'?255:0});
 fixture('UNDO01',2,{quiet:14});
 await writeFile(file,JSON.stringify({version:1,rooms:fixtures}));
 async function start(){child=spawn(process.execPath,['server/server.js'],{env:{...process.env,PORT:'32258',ADMIN_KEY:key,SIGUO_DATA_DIR:dir,SIGUO_ROOMS_FILE:file,SIGUO_AVATARS_DIR:path.join(dir,'avatars'),SIGUO_PICTURES_DIR:path.join(dir,'pictures')},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(String(d).includes('已启动'))resolve();});child.once('exit',()=>reject(Error(errors)));});}
 async function stop(){if(child&&child.exitCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;}}
 t.after(async()=>{sockets.forEach(s=>s.disconnect());await stop();await rm(dir,{recursive:true,force:true});});await start();
 async function api(url,method='GET',body,token){const r=await secureFetch(base+url,{method,headers:{'content-type':'application/json','x-admin-key':key,...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return r.json();}
 await api('/api/admin/accounts','POST',{username:'Host',password:'test1234'});await api('/api/admin/accounts','POST',{username:'Other',password:'test1234'});
 let token=(await api('/api/login','POST',{username:'Host',password:'test1234'})).token;
 async function connect(code){const s=io(base,{transports:['websocket'],forceNew:true});sockets.push(s);await event(s,'connect');const pending=event(s,'room-state');s.emit('join-room',{code,authToken:token});await pending;return s;}
 async function move(s,battle=false){const p=event(s,'room-state');s.emit('move',battle?{from:'north-0-0',to:'north-0-1'}:{from:'north-1-0',to:'north-1-1'});return p;}
 // Invalid requests and non-move events never count as steps.
 const quiet=await connect('QUIET1');let pending=event(quiet,'game-error');quiet.emit('move',{from:'invalid',to:'invalid'});await pending;
 let state=await move(quiet);assert.equal(state.drawn,true);assert.equal(state.ply,1);assert.equal(state.canUndo,false);
 const human=await connect('HUMAN1');assert.equal((await move(human)).phase,'playing');
 for(const n of [2,3,4]){const s=await connect('LIMIT'+n);state=await move(s);assert.equal(state.drawn,true);assert.equal(state.ply,n*128);}
 for(const id of ['CAPTUR','LOSING','BOMBED']){const s=await connect(id);state=await move(s,true);assert.equal(state.phase,'playing');}
 const flag=await connect('FLAG01');state=await move(flag,true);assert.equal(state.phase,'finished');assert.equal(state.drawn,false);
 const undo=await connect('UNDO01');state=await move(undo);assert.equal(state.canUndo,true);pending=event(undo,'room-state',r=>r.ply===0);undo.emit('undo-move');await pending;
 sockets.forEach(s=>s.disconnect());await stop();let saved=JSON.parse(await readFile(file,'utf8')).rooms;
 assert.equal(saved.find(r=>r.code==='UNDO01').noCapturePly,14);
 for(const code of ['CAPTUR','LOSING','BOMBED'])assert.equal(saved.find(r=>r.code===code).noCapturePly,0);
 for(const n of [2,3,4])assert.equal(saved.find(r=>r.code==='LIMIT'+n).autoDrawReason,'move-limit');
 // Only resume the undo fixture: other unfinished fixtures intentionally leave a BOT turn pending.
 await writeFile(file,JSON.stringify({version:1,rooms:saved.filter(r=>r.code==='UNDO01')}));
 await start();token=(await api('/api/login','POST',{username:'Host',password:'test1234'})).token;
 const resumed=await connect('UNDO01');state=await move(resumed);assert.equal(state.phase,'playing');sockets.forEach(s=>s.disconnect());await stop();
 saved=JSON.parse(await readFile(file,'utf8')).rooms;assert.equal(saved[0].noCapturePly,15);assert.equal(saved[0].ply,1);
 assert.equal((await readFile(path.join(dir,'accounts.json'),'utf8')).includes('ratingHistory'),true);
});
