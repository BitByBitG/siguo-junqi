import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fetch as encrypted,io} from './encrypted-client.js';
const wait=(socket,event,p=()=>true)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(event,handler);reject(Error('timeout '+event));},6000);function handler(value){if(p(value)){clearTimeout(timer);socket.off(event,handler);resolve(value);}}socket.on(event,handler);});
test('case insensitive identity, access restrictions, ratings, leave acknowledgement and BOT automatic draw',{timeout:45000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'junqi-245-')),base='http://127.0.0.1:32245',key='test-admin-key-245';
 const child=spawn(process.execPath,['server/server.js'],{env:{...process.env,PORT:'32245',SIGUO_DATA_DIR:dir,SIGUO_HISTORY_DIR:path.join(dir,'history'),SIGUO_AVATARS_DIR:path.join(dir,'avatars'),SIGUO_PICTURES_DIR:path.join(dir,'pictures'),ADMIN_KEY:key},stdio:['ignore','pipe','pipe']});
 const sockets=[];let errors='';child.stderr.on('data',d=>errors+=d);
 t.after(async()=>{sockets.forEach(s=>s.disconnect());if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}await rm(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(String(d).includes('已启动'))resolve();});child.once('exit',()=>reject(Error(errors)));});
 async function api(url,method='GET',body,token,admin=false){const r=await encrypted(base+url,{method,headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(admin?{'x-admin-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 const auth={};for(const [username,accountType]of [['Host','human'],['BotOne','bot'],['BotTwo','bot']]){
  assert.equal((await api('/api/admin/accounts','POST',{username,accountType,password:'test1234'},null,true)).status,201);
  auth[username]=(await api('/api/login','POST',{username:username.toLowerCase(),password:'test1234'})).body;assert.equal(auth[username].username,username);
 }
 assert.equal((await api('/api/register','POST',{username:'HOST',password:'test1234'})).status,409);
 assert.equal((await api('/api/profile/hOsT')).body.username,'Host');
 assert.equal((await api('/api/ratings','GET',undefined,auth.BotOne.token)).status,403);
 assert.equal((await api('/api/program','GET',undefined,auth.BotOne.token)).status,200);
 for(const rating of [-100,8000])assert.equal((await api('/api/admin/accounts/host/rating','PATCH',{rating},null,true)).body.rating,rating);
 assert.equal((await api('/api/admin/accounts/host/rating','PATCH',{rating:8001},null,true)).status,400);
 assert.equal((await api('/api/admin/accounts/host/block','PATCH',{blocked:true},null,true)).status,200);
 assert.equal((await api('/api/login','POST',{username:'HOST',password:'test1234'})).status,200);
 assert.equal((await api('/api/avatar','POST',{data:'AA=='},auth.Host.token)).status,403);
 assert.equal((await api('/api/profile/host','GET',undefined,auth.Host.token)).status,200);
 const socket=io(base,{transports:['websocket'],forceNew:true});sockets.push(socket);await wait(socket,'connect');
 let pending=wait(socket,'game-error');socket.emit('create-room',{capacity:2,mode:'free',authToken:auth.Host.token});assert.match(await pending,/封禁/);
 await api('/api/admin/accounts/host/block','PATCH',{blocked:false},null,true);
 await api('/api/admin/chat','POST',{action:'ban',username:'hOsT'},null,true);
 pending=wait(socket,'room-state');socket.emit('create-room',{capacity:2,mode:'free',authToken:auth.Host.token});let state=await pending;const code=state.code;
 pending=wait(socket,'game-error');socket.emit('chat-message',{text:'muted'});assert.match(await pending,/禁言/);
 await api('/api/admin/chat','POST',{action:'unban',username:'HOST'},null,true);
 const command=async(event,payload,p=()=>true)=>{const result=wait(socket,'room-state',p);socket.emit(event,payload);return result;};
 await command('leave-seat',undefined,s=>s.spectator);
 await command('add-bot',{seat:'north',username:'botone'},s=>s.players.some(p=>p.isBot));
 await command('add-bot',{seat:'south',username:'BOTTWO'},s=>s.players.length===2);
 async function botState(name){return (await api('/api/bot/rooms/'+code,'GET',undefined,auth[name].token)).body;}
 async function action(name,action,payload={}){const view=await botState(name);return api('/api/bot/rooms/'+code+'/'+action,'POST',{assignmentId:view.assignmentId,revision:view.revision,requestId:crypto.randomUUID(),...payload},auth[name].token);}
 assert.equal((await action('BotOne','ready',{ready:true})).status,200);assert.equal((await action('BotTwo','ready',{ready:true})).status,200);
 await command('start-game',undefined,s=>s.phase==='playing');
 for(let turn=0;turn<16;turn++){
  const name=turn%2?'BotTwo':'BotOne',view=await botState(name);
  assert.equal(view.noCapturePly,turn);
  const move=view.legalMoves.find(m=>!view.pieces.some(p=>p.position===m.to));assert.ok(move);
  assert.equal((await action(name,'move',move)).status,200);
 }
 const final=await botState('BotOne');assert.equal(final.phase,'finished');assert.equal(final.drawn,true);assert.equal(final.eliminated,false);assert.equal(final.autoDrawReason,'no-capture');assert.equal(final.noCapturePly,16);assert.equal(final.totalPlyLimit,256);
 for(const name of ['BotOne','BotTwo']){const profile=(await api('/api/profile/'+name)).body;assert.equal(profile.rating,1500);assert.equal(profile.ratedGames,0);}
 const rows=(await api('/api/admin/rooms','GET',undefined,null,true)).body;assert.ok(rows[0].bytes>rows[0].chatBytes);assert.equal(rows[0].gameBytes+rows[0].chatBytes,rows[0].bytes);
 const reply=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('leave acknowledgement timeout')),6000);socket.emit('leave-room',{code},value=>{clearTimeout(timer);resolve(value);});});assert.equal(reply.ok,true);
 pending=wait(socket,'room-state');socket.emit('watch-room',{code,authToken:auth.Host.token});assert.equal((await pending).code,code);
});
