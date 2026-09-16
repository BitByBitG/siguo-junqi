import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fetch as secureFetch,io} from './encrypted-client.js';
function event(socket,name){return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error(name)),5000);socket.once(name,v=>{clearTimeout(t);resolve(v);});});}
test('CF pages, human-only ratings, BOT directory and removed current-room endpoint', {timeout:15000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'junqi-235-')),base='http://127.0.0.1:32235',key='page-tests-admin-key';
 const child=spawn(process.execPath,['server/server.js'],{env:{...process.env,PORT:'32235',SIGUO_DATA_DIR:dir, SIGUO_ROOMS_FILE:path.join(dir,'rooms.json'), SIGUO_PICTURES_DIR:path.join(dir,'pictures'), SIGUO_AVATARS_DIR:path.join(dir,'avatars'),SIGUO_PICTURES_DIR:path.join(dir,'pictures'),ADMIN_KEY:key},stdio:['ignore','pipe','pipe']});let socket;
 t.after(async()=>{socket?.disconnect();if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}await rm(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(String(d).includes('已启动'))resolve();});child.once('exit',()=>reject(Error('startup')));});
 const api=async(url,method='GET',body,token,admin=false)=>{const r=await secureFetch(base+url,{method,headers:{'content-type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...(admin?{'x-admin-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 for(const [username,accountType]of [['Human','human'],['Robot','bot']])assert.equal((await api('/api/admin/accounts','POST',{username,accountType,password:'test1234'},null,true)).status,201);
 assert.deepEqual((await api('/api/ratings')).body.map(a=>a.username),['Human']);
 assert.deepEqual((await api('/api/bots')).body.map(a=>a.username),['Robot']);
 assert.equal((await api('/api/profiles')).body.length,2);
 assert.equal((await api('/api/my-rooms')).status,404);
 const human=(await api('/api/login','POST',{username:'Human',password:'test1234'})).body;
 const robot=(await api('/api/login','POST',{username:'Robot',password:'test1234'})).body;
 socket=io(base,{transports:['websocket']});await event(socket,'connect');
 let pending=event(socket,'room-state');socket.emit('create-room',{authToken:human.token,capacity:2});const state=await pending;
 for(const url of ['/','/contests.html','/room/'+state.code,'/login.html','/ratings.html','/bots.html','/rules.html','/bot-api.html','/advertisement.html','/admin.html','/register.html','/password.html','/bot-studio.html']){
   const r=await fetch(base+url);assert.equal(r.status,200,url);const html=await r.text();assert.ok(html.includes('/site-shell.js'),url);assert.ok(html.includes('/cf-layout.css'),url);assert.ok(!html.includes('data-stealth'),url);
 }
 const homepage=await(await fetch(base)).text();assert.ok(!homepage.includes('GitHub 项目网址'));assert.ok(!homepage.includes('id="home-rules-title"'));
 const docs=await(await fetch(base+'/bot-api.html')).text();assert.ok(docs.includes('assignments'));assert.ok(docs.includes('/api/secure'));assert.ok(!docs.includes('同时只能占一个位置'));
 assert.equal(await(await fetch(base+'/BOT_API.md')).text(),await readFile('BOT_API.md','utf8'));
 assert.equal((await fetch(base+'/downloads/secure-client.js')).status,200);
});
