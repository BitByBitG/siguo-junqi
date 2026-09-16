import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import express from 'express';
import {installHostedBots} from '../server/hosted-bots.js';
import {fetch,io} from './encrypted-client.js';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
function wait(socket,event,predicate=()=>true){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.off(event,handler);reject(Error(`timeout ${event}`));},5000);
  function handler(value){if(predicate(value)){clearTimeout(timer);socket.off(event,handler);resolve(value);}}
  socket.on(event,handler);
});}
test('admin presence, image permissions/deletion, four-direction mirrors and +128 rating', {timeout:25000},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'junqi-234-')),base='http://127.0.0.1:32234',key='features234-admin-key';
  const child=spawn(process.execPath,['server/server.js'],{env:{...process.env,PORT:'32234',SIGUO_DATA_DIR:dir, SIGUO_ROOMS_FILE:path.join(dir,'rooms.json'), SIGUO_PICTURES_DIR:path.join(dir,'pictures'), SIGUO_AVATARS_DIR:path.join(dir,'avatars'),SIGUO_PICTURES_DIR:path.join(dir,'pictures'),ADMIN_KEY:key},stdio:['ignore','pipe','pipe']});
  const sockets=[];let errors='';child.stderr.on('data',d=>errors+=d);
  t.after(async()=>{for(const s of sockets)s.disconnect();if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}await rm(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(String(d).includes('已启动'))resolve();});child.once('exit',()=>reject(Error(errors)));});
  async function api(route,method='GET',body,token,admin=false){
    const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...(admin?{'x-admin-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  }
  const auth=[];
  for(const username of ['MirrorN','MirrorE','MirrorS','MirrorW']){
    assert.equal((await api('/api/admin/accounts','POST',{username,password:'test1234'},null,true)).status,201);
    auth.push((await api('/api/login','POST',{username,password:'test1234'})).body);
  }
  assert.equal((await api('/api/admin/online')).status,403);
  assert.equal((await api('/api/admin/online','GET',undefined,null,true)).body.length,0,'login alone is not online');
  assert.equal((await api('/api/presence','POST',{},auth[0].token)).status,200);
  assert.deepEqual((await api('/api/admin/online','GET',undefined,null,true)).body.map(u=>u.username),['MirrorN']);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ZkAAAAASUVORK5CYII=';
  const upload=await api('/api/images','POST',{scope:'lobby',data:png},auth[0].token);assert.equal(upload.status,200);
  const id=upload.body.url.split('/').pop();
  assert.equal((await api('/api/admin/images','GET',undefined,auth[0].token)).status,403);
  assert.equal((await api(`/api/admin/images/${id}`,'GET',undefined,auth[0].token)).status,403);
  assert.equal((await api(`/api/admin/images/${id}`,'DELETE',undefined,auth[0].token)).status,403);
  assert.equal((await api('/api/admin/images','GET',undefined,null,true)).body.total,1);
  assert.equal((await api(`/api/admin/images/${id}`,'GET',undefined,null,true)).body.data,png);
  assert.equal((await api(`/api/admin/images/${id}`,'DELETE',undefined,null,true)).status,200);
  assert.equal((await api(upload.body.url,'GET',undefined,auth[0].token)).status,404);
  assert.equal((await readdir(path.join(dir,'pictures'))).some(n=>n.endsWith('.img')),false);
  for(let i=0;i<4;i++){const socket=io(base,{transports:['websocket'],forceNew:true});sockets.push(socket);await wait(socket,'connect');}
  let promise=wait(sockets[0],'room-state');sockets[0].emit('create-room',{authToken:auth[0].token,capacity:4,mode:'alliance',rated:true});let state=await promise;
  const code=state.code,seats=['north','east','south','west'];
  for(let i=1;i<4;i++){
    promise=wait(sockets[i],'room-state');sockets[i].emit('join-room',{authToken:auth[i].token,code});let view=await promise;
    if(!view.viewerSeat){promise=wait(sockets[i],'room-state',s=>s.viewerSeat===seats[i]);sockets[i].emit('take-seat',{seat:seats[i]});await promise;}
  }
  for(let i=0;i<4;i++){
    promise=wait(sockets[i],'room-state');sockets[i].emit('mirror-setup');const once=await promise;
    const army=once.pieces.filter(p=>p.owner===once.viewerSeat);
    promise=wait(sockets[i],'room-state');sockets[i].emit('mirror-setup');const twice=await promise;
    for(const p of army){const [seat,row,col]=p.position.split('-');assert.equal(twice.pieces.find(q=>q.id===p.id).position,`${seat}-${row}-${4-Number(col)}`);}
    promise=wait(sockets[i],'room-state',s=>s.players.find(p=>p.seat===s.viewerSeat).ready);sockets[i].emit('toggle-ready');await promise;
    const denied=wait(sockets[i],'game-error');sockets[i].emit('mirror-setup');assert.match(await denied,/未准备/);
  }
  const online=(await api('/api/admin/online','GET',undefined,null,true)).body;
  assert.equal(online.length,4);assert.ok(online.every(u=>u.rooms.includes(code)));
  promise=wait(sockets[0],'room-state',s=>s.phase==='playing');sockets[0].emit('start-game');await promise;
  promise=wait(sockets[0],'room-state',s=>s.players.find(p=>p.seat==='east').eliminated);sockets[1].emit('resign');await promise;
  promise=wait(sockets[0],'room-state',s=>s.phase==='finished');sockets[3].emit('resign');state=await promise;
  assert.equal(state.ratingChanges.north.delta,128);assert.equal(state.ratingChanges.south.delta,128);
  assert.equal(state.ratingChanges.east.delta,-128);assert.equal(state.ratingChanges.west.delta,-128);
  await api('/api/logout','POST',{},auth[0].token);
  assert.ok(!(await api('/api/admin/online','GET',undefined,null,true)).body.some(u=>u.username===auth[0].username));
});

test('hosted API works with an HTTPS public server without disabling TLS verification', {timeout:6000},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'junqi-hosted-tls-')),filename=path.join(dir,'programs.json');
  await writeFile(filename,JSON.stringify({Robot:{enabled:true,source:'function act(){}'}}));
  const app=express(),sessions=new Map(),accounts={Robot:{type:'bot'}};
  const server=https.createServer({},app); // No TLS client / trusted CA needed for internal API.
  const hosted=installHostedBots({app,sessions,accounts,server,filename});
  let calls=0;
  app.get('/api/bot/session',(req,res)=>{
    const session=sessions.get(req.headers.authorization?.slice(7));assert.equal(session.username,'Robot');
    calls++;res.json({assignments:[]});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await hosted.remove('Robot');await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  for(let i=0;i<30&&!calls;i++)await pause(50);
  assert.ok(calls>0,'hosted scan reached API despite public HTTPS');
});
