import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DdzTable} from './ddz-engine.js';
import {atomicWrite} from './room-archive.js';
import {emojis} from '../public/emojis.js';
export function installDdz(app,{accounts,authorize,profile,canonicalUsername,isAdmin,changeChat,groupCan,isGloballyMuted,dataDir,canCreateRoom,useRoomQuota}){
 const rooms=new Map(),scores=Object.create(null),file=path.join(dataDir,'ddz-rooms.json'),limits=new Map(),seen=new Map();
 if(fs.existsSync(file)){const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==1)throw Error('斗地主存档版本无效');Object.assign(scores,data.scores);for(const r of data.rooms){r.table=Object.assign(new DdzTable(),r.table);r.members=new Set(r.members);r.table.deadline=0;delete r.table.time;if(!Array.isArray(r.table.publicPlays)){const remaining=new Set(r.table.players.flatMap(p=>p?.cards||[]));if(r.table.landlord<0)for(const c of r.table.bottom||[])remaining.add(c);r.table.publicPlays=r.table.hand?Array.from({length:r.table.max===3?54:108},(_,i)=>i).filter(c=>!remaining.has(c)):[];}rooms.set(r.id,r);}}
 const serialize=()=>JSON.stringify({version:1,scores,rooms:[...rooms.values()].map(r=>({...r,members:[...r.members]}))});
 function restore(s){const d=JSON.parse(s);for(const k of Object.keys(scores))delete scores[k];Object.assign(scores,d.scores);rooms.clear();for(const r of d.rooms){r.table=Object.assign(new DdzTable(),r.table);r.members=new Set(r.members);rooms.set(r.id,r);}}
 function settle(){for(const r of rooms.values())if(r.table.pendingResults){for(const {id,delta}of r.table.pendingResults){const before=scores[id]||0;const change=r.table.result?.deltas.find(d=>d.id===id);if(change)change.before=before;const next=before+delta;if(change)change.after=next;if(!Number.isSafeInteger(next))throw Error('积分超出范围');scores[id]=next;}r.table.pendingResults=null;}}
 const save=()=>{};
 function transact(fn){const before=serialize();try{const result=fn();settle();const after=serialize();if(before!==after)atomicWrite(file,after);return result;}catch(e){restore(before);throw e;}}
 const error=(message,status=400)=>Object.assign(Error(message),{status});
 const int=(v,min,max)=>{v=Number(v);if(!Number.isInteger(v)||v<min||v>max)throw error('参数无效');return v;};
 const text=(v,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw error('文字长度无效');return v.trim();};
 function permitted(n){const a=accounts[n];return !!a&&a.type!=='bot'&&a.status!=='pending'&&!a.blocked;}
 function user(req){const n=authorize(req)?.username;if(!n)throw error('请先登录',401);if(!permitted(n))throw error('账号无法参加斗地主',403);seen.set(n,Date.now());return n;}
 function mutation(n){if(!groupCan(n,'play'))throw error('你所在分组已暂停下棋功能',403);const now=Date.now(),v=limits.get(n)||{time:now,count:0};if(now-v.time>60000){v.time=now;v.count=0;}limits.set(n,v);if(++v.count>180)throw error('请求过于频繁',429);}
 function room(req,n){const r=rooms.get(req.params.id);if(!r)throw error('房间不存在',404);if(!r.members.has(n))throw error('请先进入房间',403);return r;}
 function owner(req,r,n){if(r.owner!==n&&!isAdmin(req))throw error('只有房主或管理员可以操作',403);}
 const detail=r=>({id:r.id,name:r.name,owner:r.owner,max:r.table.max,phase:r.table.phase,players:r.table.players.filter(Boolean).length,createdAt:r.createdAt});
 function view(r,n){settle();const v=r.table.view(n);return {...detail(r),...v,score:scores[n]||0,serverTime:Date.now(),canModerate:r.owner===n||!!accounts[n]?.admin,members:[...r.members].filter(n=>accounts[n]).map(username=>({username,...profile(username),online:Date.now()-(seen.get(username)||0)<15000})),players:v.players.map(p=>p?{...p,username:p.id,...profile(p.id),online:Date.now()-(seen.get(p.id)||0)<15000,score:scores[p.id]||0}:null),chat:r.chat.map(m=>({...m,...profile(m.name)})),muted:r.muted};}
 const route=(method,url,fn)=>app[method](url,(req,res)=>{try{res.set('Cache-Control','no-store');if(method==='get'){fn(req,res);return;}let body,status=200;const reply={json:v=>{body=v;return reply;},status:v=>{status=v;return reply;}};transact(()=>fn(req,reply));res.status(status).json(body);}catch(e){res.status(e.status||400).json({error:e.message});}});
 route('get','/api/ddz/ratings',(req,res)=>{user(req);res.json(Object.keys(accounts).filter(n=>accounts[n].type!=='bot'&&accounts[n].status!=='pending').map(username=>({username,...profile(username),score:scores[username]||0})).sort((a,b)=>b.score-a.score||a.username.localeCompare(b.username)).map((p,i)=>({position:i+1,...p})));});
 route('get','/api/ddz/rooms',(req,res)=>{user(req);res.json([...rooms.values()].map(detail));});
 route('post','/api/ddz/rooms',(req,res)=>{const n=user(req);mutation(n);const quota=canCreateRoom(n);if(!quota.ok)throw error(quota.error,403);if(rooms.size>=100)throw error('房间数量已满');const b=req.body||{},max=int(b.max??3,3,4),id=crypto.randomBytes(4).toString('hex').toUpperCase(),r={id,name:b.name?text(b.name,40):id,owner:n,createdAt:Date.now(),members:new Set([n]),chat:[],muted:[],table:new DdzTable({max})};rooms.set(id,r);useRoomQuota(n);res.status(201).json(view(r,n));});
 route('get','/api/ddz/rooms/:id',(req,res)=>{const n=user(req);res.json(view(room(req,n),n));});
 route('post','/api/ddz/rooms/:id/join',(req,res)=>{const n=user(req),r=rooms.get(req.params.id);if(!r)throw error('房间不存在',404);if(r.members.size>=50&&!r.members.has(n))throw error('房间已满');r.members.add(n);res.json(view(r,n));});
 route('post','/api/ddz/rooms/:id/action',(req,res)=>{const n=user(req),r=room(req,n),t=r.table,b=req.body||{},p=t.players.find(p=>p?.id===n);mutation(n);
 if(b.op==='seat')t.seat(n,int(b.index,0,t.max-1));
 else if(b.op==='stand')t.leave(n);
 else if(b.op==='settings'){owner(req,r,n);t.resize(int(b.max,3,4));}
 else if(b.op==='ready'){if(!p)throw error('请先落座');if(['bidding','playing'].includes(t.phase))throw error('请等待本局结束');p.ready=!p.ready;t.version++;}
 else if(b.op==='start'){owner(req,r,n);if(t.players.some(p=>p&&!permitted(p.id)))throw error('账号无法参加斗地主',403);t.start();}
 else if(b.op==='undo'){if(b.version!==t.version)throw error('牌局状态已更新，请重试',409);t.undoPlay(n);}
 else if(b.op==='bid'||b.op==='play'||b.op==='pass'){if(b.version!==t.version||b.hand!==t.hand||b.turn!==t.turn)throw error('牌局状态已更新，请重试',409);if(b.op==='bid')t.bidAction(n,b.value);else{if(b.op==='play'&&(!Array.isArray(b.cards)||!b.cards.length))throw error('请先选择要出的牌');t.play(n,b.op==='pass'?[]:b.cards);}}
 else if(b.op==='leave'){t.leave(n);r.members.delete(n);if(r.owner===n)r.owner=[...r.members][0]||n;return res.json({ok:true});}
 else if(b.op==='close'){owner(req,r,n);rooms.delete(r.id);return res.json({ok:true});}
 else if(b.op==='kick'){owner(req,r,n);const target=canonicalUsername(b.username);if(target===n)throw error('不能踢出自己');t.leave(target);r.members.delete(target);}
 else throw error('未知操作');res.json(view(r,n));});
 function canChat(n,r){if(!groupCan(n,'chat'))throw error('你所在分组已暂停聊天功能',403);if(isGloballyMuted(n)||r.muted.includes(n))throw error('你已被禁言',403);}
 route('post','/api/ddz/rooms/:id/chat',(req,res)=>{const n=user(req),r=room(req,n);canChat(n,r);const value=text(req.body.text,8000),recent=r.chat.at(-1);if(recent?.name===n&&Date.now()-recent.time<700)throw error('请求过于频繁',429);r.chat.push({id:crypto.randomUUID(),name:n,text:value,time:Date.now()});r.chat=r.chat.slice(-100);save();res.json({ok:true});});
 route('post','/api/ddz/rooms/:id/chat-action',(req,res)=>{
  const n=user(req),r=room(req,n),b=req.body||{},m=r.chat.find(m=>m.id===b.id);
  if(b.action==='react'){canChat(n,r);if(!m||m.recalled||!emojis.includes(b.emoji))throw error('无效操作');m.reactions||={};const users=m.reactions[b.emoji]||=[];const i=users.indexOf(n);if(i<0)users.push(n);else users.splice(i,1);if(!users.length)delete m.reactions[b.emoji];}
  else if(b.action==='recall-own'){if(!m||m.name!==n||Date.now()-m.time>300000)throw error('超过 5 分钟，无法撤回');m.text='';m.recalled=true;delete m.reactions;}
  else{owner(req,r,n);if(!['mute','unmute','delete'].includes(b.action))throw error('无效操作');const message=changeChat(r.chat,r.muted,{...b,username:b.username?canonicalUsername(b.username):undefined},isAdmin(req)?3:1,n);if(message)throw error(message);}save();res.json({ok:true});
 });
 route('get','/api/admin/ddz',(req,res)=>{if(!isAdmin(req))throw error('需要管理员权限',403);res.json({accounts:Object.keys(accounts).filter(n=>accounts[n].type!=='bot'&&accounts[n].status!=='pending').map(username=>({username,...profile(username),score:scores[username]||0})),rooms:[...rooms.values()].map(detail),bytes:fs.existsSync(file)?fs.statSync(file).size:0});});
 route('post','/api/admin/ddz/scores',(req,res)=>{if(!isAdmin(req))throw error('需要管理员权限',403);const b=req.body||{};if(!Array.isArray(b.usernames)||!b.usernames.length||b.usernames.length>10000||typeof b.score!=='number'||!Number.isSafeInteger(b.score)||Math.abs(b.score)>1000000000)throw error('积分必须是-1000000000至1000000000的整数');const names=[...new Set(b.usernames.map(n=>typeof n==='string'?canonicalUsername(n):''))];for(const n of names)if(!Object.hasOwn(accounts,n)||accounts[n].type==='bot'||accounts[n].status==='pending')throw error('账号不存在或不是玩家账号');for(const n of names)scores[n]=b.score;res.json({ok:true,count:names.length,score:b.score});});
 route('post','/api/admin/ddz/rooms/:id',(req,res)=>{if(!isAdmin(req))throw error('需要管理员权限',403);const r=rooms.get(req.params.id);if(!r)throw error('房间不存在',404);const b=req.body||{};if(b.action==='delete')rooms.delete(r.id);else if(b.action==='end')r.table.cancel();else if(b.action==='clear-chat')r.chat=[];else if(b.action==='chat')return res.json({messages:r.chat.map(m=>({...m,...profile(m.name)})),muted:r.muted});else if(b.action==='moderate'){const payload={...b.payload};if(!['mute','unmute','delete'].includes(payload.action))throw error('无效操作');if(payload.username)payload.username=canonicalUsername(payload.username);const msg=changeChat(r.chat,r.muted,payload,3,null);if(msg)throw error(msg);}else throw error('无效操作');res.json({ok:true});});
 const timer=setInterval(()=>{try{const cancelled=[...rooms.values()].filter(r=>['bidding','playing'].includes(r.table.phase)&&r.table.players.some(p=>p&&!permitted(p.id)));if(cancelled.length)transact(()=>{for(const r of cancelled)r.table.cancel();});}catch(e){console.error('[ddz]',e.message);}},1000);timer.unref();
 return {canEnter:(n,s)=>s.startsWith('ddz:')&&permitted(n)&&!!rooms.get(s.slice(4))?.members.has(n),isMuted:(n,s)=>isGloballyMuted(n)||!!rooms.get(s.slice(4))?.muted.includes(n)};
}
