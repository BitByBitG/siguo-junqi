import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fetch} from './encrypted-client.js';

test('Hold’em shares accounts, enforces access, hides cards and supports shared chat/admin',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'junqi-holdem-test-')),port=32873,url='http://127.0.0.1:'+port,key='holdem-test-admin-key-123';
 const env={...process.env,PORT:String(port),ADMIN_KEY:key,SIGUO_DATA_DIR:dir,SIGUO_HISTORY_DIR:path.join(dir,'history'),SIGUO_PICTURES_DIR:path.join(dir,'images'),SIGUO_AVATARS_DIR:path.join(dir,'avatars')};delete env.SIGUO_TLS_CERT;delete env.SIGUO_TLS_KEY;delete env.ACCOUNTS_FILE;
 let child,logs='';async function boot(){child=spawn(process.execPath,['server/server.js'],{cwd:new URL('../',import.meta.url),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<120;i++){try{if((await globalThis.fetch(url+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,60));}throw Error(logs);}
 async function stop(){if(child?.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}}
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});await boot();
 async function req(route,token,body,method=body===undefined?'GET':'POST',admin=false){const r=await fetch(url+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(admin?{'x-admin-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
 const tokens={};for(const username of ['Alpha','Bravo','Watcher','BlockedBot']){assert.equal((await req('/api/admin/accounts',null,{username,password:'test1234',accountType:username==='BlockedBot'?'bot':'human'},'POST',true)).status,201);tokens[username]=(await req('/api/login',null,{username,password:'test1234'})).body.token;}
 assert.equal((await globalThis.fetch(url+'/api/holdem/rooms')).status,426);
 assert.equal((await req('/api/holdem/rooms')).status,401);assert.equal((await req('/api/holdem/rooms',tokens.Alpha)).status,403);
 const change=async(names,enabled)=>req('/api/admin/holdem/permissions',null,{usernames:names,enabled},'PATCH',true);
 assert.equal((await change(['Alpha','Bravo','Watcher'],true)).status,200);assert.equal((await change(['BlockedBot'],true)).status,400);
 assert.equal((await req('/api/me',tokens.Alpha)).body.holdemEnabled,true);
 assert.equal((await req('/api/holdem/wallet',tokens.Alpha)).body.balance,10000);
 const grant={usernames:['Alpha','Bravo'],amount:500,requestId:'integration-grant-1'};
 assert.equal((await req('/api/admin/holdem/chips',null,grant,'POST',true)).status,200);
 assert.equal((await req('/api/admin/holdem/chips',null,grant,'POST',true)).status,200);
 assert.equal((await req('/api/holdem/wallet',tokens.Alpha)).body.balance,10500);
 assert.equal((await req('/api/admin/holdem/chips',null,{...grant,usernames:['Alpha','missing'],requestId:'integration-grant-2'},'POST',true)).status,400);
 assert.equal((await req('/api/admin/holdem/settings',null,{initial:7000,daily:1000},'PATCH',true)).status,200);
 assert.equal((await req('/api/holdem/wallet',tokens.Alpha)).body.balance,10500);
 const created=await req('/api/holdem/rooms',tokens.Alpha,{name:'Shared Table',max:2,stack:2000,sb:10,time:30});assert.equal(created.status,201);const id=created.body.id,base='/api/holdem/rooms/'+id;
 assert.equal((await req(base,tokens.Bravo)).status,403);
 const upload=await req('/api/images',tokens.Alpha,{scope:'holdem:'+id,data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhQAAAABJRU5ErkJggg=='});assert.equal(upload.status,200);assert.equal((await req(upload.body.url,tokens.Watcher)).status,403);
 for(const name of ['Bravo','Watcher'])assert.equal((await req(base+'/join',tokens[name],{})).status,200);
 assert.equal((await req(upload.body.url,tokens.Watcher)).status,200);
 for(const [name,index]of [['Alpha',0],['Bravo',1]]){assert.equal((await req(base+'/action',tokens[name],{op:'seat',index})).status,200);assert.equal((await req(base+'/action',tokens[name],{op:'ready'})).status,200);}
 assert.equal((await req('/api/holdem/wallet',tokens.Alpha)).body.balance,8500);
 assert.equal((await req(base+'/action',tokens.Alpha,{op:'seat',index:0})).status,400);
 assert.equal((await req('/api/holdem/wallet',tokens.Alpha)).body.balance,8500);
 assert.equal((await req(base+'/action',tokens.Bravo,{op:'start'})).status,403);assert.equal((await req(base+'/action',tokens.Alpha,{op:'start'})).status,200);
 let state=(await req(base,tokens.Alpha)).body;assert(state.members.some(p=>p.username==='Watcher'&&p.online));assert(state.players[0].hole.every(Number.isInteger));assert(state.players[1].hole.every(x=>x===null));assert((await req(base,tokens.Watcher)).body.players.every(p=>p.hole.every(x=>x===null)));
 const first={op:'bet',type:'call',hand:state.hand,turn:state.turn,version:state.version};assert.equal((await req(base+'/action',tokens.Alpha,first)).status,200);assert.equal((await req(base+'/action',tokens.Alpha,first)).status,409);
 assert.equal((await req(base+'/chat',tokens.Bravo,{text:'**hello** $x^2$ @Alpha'})).status,200);state=(await req(base,tokens.Alpha)).body;const message=state.chat[0];assert.equal(message.text,'**hello** $x^2$ @Alpha');assert.equal(typeof message.time,'number');assert.equal(message.name,'Bravo');
 assert.equal((await req(base+'/chat-action',tokens.Alpha,{action:'react',id:message.id,emoji:'👍'})).status,200);
 assert.equal((await req(base+'/chat-action',tokens.Alpha,{action:'mute',username:'Bravo'})).status,200);assert.equal((await req(base+'/chat',tokens.Bravo,{text:'muted'})).status,403);
 const admin='/api/admin/holdem/rooms/'+id;assert.equal((await req(admin,tokens.Bravo,{action:'delete'})).status,403);
 assert.equal((await req(admin,null,{action:'moderate',payload:{action:'unmute',username:'Bravo'}},'POST',true)).status,200);
 assert.equal((await req('/api/admin/chat',null,{action:'ban',username:'Watcher'},'POST',true)).status,200);assert.equal((await req(base+'/chat',tokens.Watcher,{text:'globally muted'})).status,403);
 assert.equal((await req(admin,null,{action:'chat'},'POST',true)).body.messages.length,1);
 assert.equal((await req(base+'/chat-action',tokens.Bravo,{action:'recall-own',id:message.id})).status,200);assert.equal((await req(base,tokens.Alpha)).body.chat[0].recalled,true);
 assert.equal((await req(admin,null,{action:'moderate',payload:{action:'delete',id:message.id}},'POST',true)).status,200);assert.equal((await req(base,tokens.Alpha)).body.chat.length,0);
 await change(['Bravo'],false);assert.equal((await req(base,tokens.Bravo)).status,403);assert.equal((await req('/api/me',tokens.Bravo)).body.holdemEnabled,false);assert.equal((await req(base,tokens.Alpha)).body.phase,'finished');
 await stop();const persisted=JSON.parse(await readFile(path.join(dir,'holdem-rooms.json'),'utf8'));assert.equal(persisted.rooms[0].id,id);await boot();const login=await req('/api/login',null,{username:'Alpha',password:'test1234'});tokens.Alpha=login.body.token;assert.equal((await req(base,tokens.Alpha)).status,200);
 assert.equal((await req(admin,null,{action:'delete'},'POST',true)).status,200);assert.equal((await req(base,tokens.Alpha)).status,404);
 assert.equal((await req('/api/holdem/wallet',tokens.Alpha)).body.balance,10520);
});
