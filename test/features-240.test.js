import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fetch as encrypted,io} from './encrypted-client.js';
const wait=(s,event,p=()=>true)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>{s.off(event,f);reject(Error('timeout '+event));},6000);function f(v){if(p(v)){clearTimeout(t);s.off(event,f);resolve(v);}}s.on(event,f);});
test('history, avatars, automatic rating pools, unanimous draws and admin controls',{timeout:45000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'junqi-240-')),base='http://127.0.0.1:32240',key='features-240-admin-key';
 const sockets=[];let child,stderr='';
 async function start(){child=spawn(process.execPath,['server/server.js'],{env:{...process.env,PORT:'32240',SIGUO_DATA_DIR:dir,SIGUO_HISTORY_DIR:path.join(dir,'history'),SIGUO_AVATARS_DIR:path.join(dir,'avatars'),SIGUO_PICTURES_DIR:path.join(dir,'pictures'),ADMIN_KEY:key},stdio:['ignore','pipe','pipe']});child.stderr.on('data',d=>stderr+=d);await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(String(d).includes('已启动'))resolve();});child.once('exit',()=>reject(Error(stderr)));});}
 async function stop(){if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}}
 t.after(async()=>{sockets.forEach(s=>s.disconnect());await stop();await rm(dir,{recursive:true,force:true});});await start();
 async function api(url,method='GET',body,token,admin=false){const r=await encrypted(base+url,{method,headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(admin?{'x-admin-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 const auth={};for(const [username,accountType]of [['Host','admin'],['Guest','human'],['BotOne','bot'],['BotTwo','bot']]){assert.equal((await api('/api/admin/accounts','POST',{username,accountType,password:'test1234'},null,true)).status,201);auth[username]=(await api('/api/login','POST',{username,password:'test1234'})).body;}
 assert.equal((await api('/api/admin/groups/default','PATCH',{dailyRoomLimit:100,keepRoomHistory:true},null,true)).status,200);
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ZkAAAAASUVORK5CYII=';
 assert.equal((await api('/api/avatar','POST',{data:png})).status,401);
 const a1=await api('/api/avatar','POST',{data:png},auth.Host.token);assert.equal(a1.status,200);
 const a2=await api('/api/avatar','POST',{data:png},auth.Host.token);assert.notEqual(a1.body.avatar,a2.body.avatar);assert.deepEqual(await readdir(path.join(dir,'avatars')),[a2.body.avatar+'.img']);
 assert.equal((await api('/api/avatar/Host')).body.data,png);
 assert.equal((await api('/api/avatar','POST',{data:Buffer.from('<svg/>').toString('base64')},auth.Host.token)).status,400);
 async function connect(){const s=io(base,{transports:['websocket'],forceNew:true});sockets.push(s);await wait(s,'connect');return s;}
 async function command(s,event,payload,p){const promise=wait(s,'room-state',p);s.emit(event,payload);return await promise;}
 async function room(){const s=await connect(),state=await command(s,'create-room',{authToken:auth.Host.token,capacity:2,mode:'ffa',rated:false});return {s,code:state.code};}
 async function humans(){const r=await room(),other=await connect();let v=await command(other,'join-room',{authToken:auth.Guest.token,code:r.code});if(!v.viewerSeat)await command(other,'take-seat',{seat:'south'},v=>v.viewerSeat==='south');await command(r.s,'toggle-ready',undefined,v=>v.players.find(p=>p.seat==='north').ready);await command(other,'toggle-ready',undefined,v=>v.players.find(p=>p.seat==='south').ready);await command(r.s,'start-game',undefined,v=>v.phase==='playing');return {...r,other};}
 const first=await humans();
 let pending=wait(first.s,'room-state',v=>v.phase==='finished');first.other.emit('resign');let state=await pending;assert.equal(state.rated,true);assert.equal(state.ratingChanges.north.delta,128);assert.equal(state.ratingChanges.south.delta,-128);
 const profile=(await api('/api/profile/Host')).body;assert.equal(profile.history.length,1);assert.equal(profile.rating,1628);
 await command(first.s,'chat-message',{text:'保留聊天'},v=>v.chat.some(m=>m.text==='保留聊天'));
 const replay=(await api('/api/rooms/'+first.code+'/replay','GET',undefined,auth.Host.token)).body;assert.ok(replay.frames.length>=2);assert.equal(replay.chat[0].text,'保留聊天');const frameCount=replay.frames.length;
 await command(first.s,'close-room',undefined,v=>v.phase==='finished');assert.ok((await api('/api/rooms')).body.some(r=>r.code===first.code));
 assert.equal((await api('/api/rooms/'+first.code+'/replay','GET',undefined,auth.Host.token)).body.frames.length,frameCount);
 assert.equal((await api('/api/admin/rooms/'+first.code+'/chat','DELETE',undefined,auth.Guest.token)).status,403);
 const draw=await humans();state=await command(draw.s,'draw-vote',{accept:true},v=>v.drawOffer);const oldId=state.drawOffer.id;
 assert.equal(state.drawOffer.accepted.length,1);
 const rejected=wait(draw.s,'room-state',v=>!v.drawOffer);draw.other.emit('draw-vote',{accept:false,offerId:oldId});await rejected;
 state=await command(draw.s,'draw-vote',{accept:true},v=>v.drawOffer);assert.notEqual(state.drawOffer.id,oldId);
 const denied=wait(draw.other,'game-error');draw.other.emit('draw-vote',{accept:true,offerId:oldId});assert.match(await denied,/变化/);
 pending=wait(draw.s,'room-state',v=>v.phase==='finished');draw.other.emit('draw-vote',{accept:true,offerId:state.drawOffer.id});state=await pending;
 assert.equal(state.drawn,true);assert.equal(state.ratingChanges,null);assert.equal((await api('/api/profile/Host')).body.history.length,1);
 async function botAction(code,name,action,extra={},seat){const session=(await api('/api/bot/session','GET',undefined,auth[name].token)).body;const assignment=session.assignments.find(a=>a.code===code&&(!seat||a.seat===seat));assert.ok(assignment,JSON.stringify(session));const v=(await api('/api/bot/rooms/'+code+'?assignmentId='+assignment.assignmentId,'GET',undefined,auth[name].token)).body;const r=await api('/api/bot/rooms/'+code+'/'+action,'POST',{assignmentId:assignment.assignmentId,revision:v.revision,requestId:crypto.randomUUID(),...extra},auth[name].token);assert.equal(r.status,200,JSON.stringify(r));return v;}
 const bots=await room();await command(bots.s,'leave-seat',undefined,v=>v.spectator);await command(bots.s,'add-bot',{seat:'north',username:'BotOne'},v=>v.players.some(p=>p.isBot));await command(bots.s,'add-bot',{seat:'south',username:'BotTwo'},v=>v.players.every(p=>p.isBot));await botAction(bots.code,'BotOne','ready',{ready:true});await botAction(bots.code,'BotTwo','ready',{ready:true});state=await command(bots.s,'start-game',undefined,v=>v.phase==='playing');assert.equal(state.rated,true);
 pending=wait(bots.s,'room-state',v=>v.phase==='finished');await botAction(bots.code,'BotTwo','resign');state=await pending;assert.equal(state.ratingChanges.north.delta,128);
 assert.equal((await api('/api/profile/BotOne')).body.rating,1628);assert.equal((await api('/api/ratings?type=bot')).body.length,2);assert.ok((await api('/api/ratings')).body.every(p=>p.accountType==='human'));
 const mixed=await room();await command(mixed.s,'add-bot',{seat:'south',username:'BotTwo'},v=>v.players.some(p=>p.isBot));await command(mixed.s,'toggle-ready',undefined,v=>v.players.find(p=>p.seat==='north').ready);await botAction(mixed.code,'BotTwo','ready',{ready:true});state=await command(mixed.s,'start-game',undefined,v=>v.phase==='playing');assert.equal(state.rated,false);
 pending=wait(mixed.s,'room-state',v=>v.phase==='finished');await botAction(mixed.code,'BotTwo','resign');await pending;assert.equal((await api('/api/profile/Host')).body.history.length,1);
 for(const drawGame of [true,false]){
   const r=await room();await command(r.s,'leave-seat',undefined,v=>v.spectator);
   await command(r.s,'add-bot',{seat:'north',username:'BotOne'},v=>v.players.some(p=>p.isBot));await command(r.s,'add-bot',{seat:'south',username:'BotOne'},v=>v.players.every(p=>p.isBot));
   for(const seat of ['north','south'])await botAction(r.code,'BotOne','ready',{ready:true},seat);
   await command(r.s,'start-game',undefined,v=>v.phase==='playing');
   if(drawGame){
     pending=wait(r.s,'room-state',v=>v.drawOffer);await botAction(r.code,'BotOne','draw',{accept:true},'north');const offer=(await pending).drawOffer;
     pending=wait(r.s,'room-state',v=>v.phase==='finished');await botAction(r.code,'BotOne','draw',{accept:true,offerId:offer.id},'south');assert.equal((await pending).drawn,true);
     assert.equal((await api('/api/profile/BotOne')).body.ratedGames,1);
   }else{
     pending=wait(r.s,'room-state',v=>v.phase==='finished');await botAction(r.code,'BotOne','resign',{},'south');await pending;
     const p=(await api('/api/profile/BotOne')).body;assert.equal(p.ratedGames,2);assert.equal(p.rating,1628);assert.equal(p.history.at(-1).delta,0);
   }
 }
 const interrupted=await humans();assert.equal((await api('/api/admin/rooms/'+interrupted.code+'/finish','POST',{},auth.Guest.token)).status,403);assert.equal((await api('/api/admin/rooms/'+interrupted.code+'/finish','POST',{},auth.Host.token)).status,200);assert.equal((await api('/api/profile/Host')).body.history.length,1);
 for(const url of ['/profile/Host','/settings.html','/contests.html','/ratings.html?type=bot','/bot-api.html'])assert.equal((await globalThis.fetch(base+url)).status,200,url);
 const docs=await(await globalThis.fetch(base+'/bot-api.html')).text();assert.ok(docs.includes('download="BOT_API.md"'));
 sockets.forEach(s=>s.disconnect());await stop();const archive=JSON.parse(await readFile(path.join(dir,'history','rooms.json'),'utf8'));assert.equal(archive.rooms.length,7);assert.ok(archive.rooms.find(r=>r.code===first.code).chat.some(m=>m.text==='保留聊天'));await start();
 assert.equal((await api('/api/rooms')).body.length,7);assert.equal((await api('/api/avatar/Host')).body.data,png);
 assert.equal((await api('/api/admin/rooms/'+first.code+'/chat','DELETE',undefined,null,true)).status,200);
 assert.equal((await api('/api/admin/rooms/'+first.code,'DELETE',undefined,null,true)).status,200);assert.equal((await api('/api/rooms')).body.length,6);
 assert.equal((await api('/api/profile/Host')).body.rating,1628);
 assert.equal((await api('/api/avatar','DELETE')).status,401);
 const relogged=(await api('/api/login','POST',{username:'Host',password:'test1234'})).body;
 assert.equal((await api('/api/avatar','DELETE',undefined,relogged.token)).status,200);
 assert.deepEqual(await readdir(path.join(dir,'avatars')),[]);
 assert.equal((await api('/api/profile/Host')).body.avatar,null);
 for(let i=0;i<11;i++)assert.equal((await api('/api/admin/accounts','POST',{username:'Page'+String(i).padStart(2,'0'),password:'test1234'},null,true)).status,201);
 const listed=(await api('/api/admin/accounts?details=1','GET',undefined,null,true)).body;
 assert.equal(listed.length,15);assert.equal(new Set(listed.map(a=>a.username)).size,15);
 const target=listed[0].username;
 assert.equal((await api('/api/admin/accounts/'+target+'/rating','PATCH',{rating:1800},null,true)).status,200);
 assert.equal((await api('/api/profile/'+target)).body.history.at(-1).after,1800);
});
