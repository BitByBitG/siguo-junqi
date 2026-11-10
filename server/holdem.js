import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Table,STAGES} from './holdem-engine.js';
import {atomicWrite} from './room-archive.js';
import {emojis} from '../public/emojis.js';
import {ChipBank,chipInteger,beijingDay} from './holdem-bank.js';

export function installHoldem(app,{accounts,authorize,profile,saveAccounts,canonicalUsername,isAdmin,changeChat,groupCan,isGloballyMuted,dataDir,onAccountChange,canCreateRoom,useRoomQuota}){
 const rooms=new Map(),seen=new Map(),limits=new Map(),file=path.join(dataDir,'holdem-rooms.json');let archive=null,inTransaction=false,dirty=false,synchronizedDay=-1;
 const save=()=>{if(!inTransaction)throw Error('筹码操作必须在事务中');dirty=true;};
 if(fs.existsSync(file)){
  try{archive=JSON.parse(fs.readFileSync(file,'utf8'));if(![1,2].includes(archive?.version)||!Array.isArray(archive.rooms))throw Error('Invalid archive');}catch(e){throw Error(`德州扑克存档读取失败，原文件未修改：${e.message}`);}
  for(const r of archive.rooms){r.table=Object.assign(new Table(),r.table);r.table.funded=true;r.members=new Set(r.members);if(STAGES.includes(r.table.phase))r.table.deadline=Date.now()+r.table.time*1000;rooms.set(r.id,r);}
 }
 function holdings(n){let tableChips=0,committed=0;for(const r of rooms.values())for(const p of r.table.players)if(p?.id===n){tableChips+=p.chips;if(STAGES.includes(r.table.phase))committed+=p.total||0;}return {tableChips:chipInteger(tableChips),committed:chipInteger(committed)};}
 const bank=new ChipBank(accounts,archive?.bank,n=>{const h=holdings(n);return h.tableChips+h.committed;});
 const serialize=()=>JSON.stringify({version:2,rooms:[...rooms.values()].map(r=>({...r,members:[...r.members]})),bank:bank.state()});
 function restore(body){const data=JSON.parse(body);rooms.clear();for(const r of data.rooms){r.table=Object.assign(new Table(),r.table);r.members=new Set(r.members);rooms.set(r.id,r);}bank.restore(data.bank);}
 function settle(){for(const r of rooms.values())for(const c of r.table.takeCashouts()){bank.credit(c.id,c.amount);bank.record('cashout','system',[c.id],c.amount,{room:r.id});}}
 function transaction(fn){if(inTransaction)return fn();const before=serialize();inTransaction=true;dirty=false;try{bank.syncAll();const value=fn();settle();bank.validate();for(const r of rooms.values())for(const p of r.table.players)if(p){chipInteger(p.chips);chipInteger(p.bet||0);chipInteger(p.total||0);}const after=serialize();if(dirty||after!==before)atomicWrite(file,after);return value;}catch(e){restore(before);throw e;}finally{inTransaction=false;dirty=false;}}
 function syncDay(){const day=beijingDay(Date.now());if(synchronizedDay!==day){transaction(()=>{});synchronizedDay=day;}}
 function wallet(n){let w=bank.wallets[n];if(!w){transaction(()=>bank.sync(n));w=bank.wallets[n];}if(!w)throw error('德州扑克权限未开通或已停用',403);const h=holdings(n);return {balance:w.balance,...h,total:chipInteger(w.balance+h.tableChips+h.committed)};}
 function endHand(r){r.table.chipChanges=[];r.table.revealHands();for(const p of r.table.players)if(p){p.ready=false;if(STAGES.includes(r.table.phase)){p.chips=chipInteger(p.chips+(p.total||0));p.bet=0;p.total=0;}}r.table.phase='finished';r.table.turn=-1;r.table.deadline=0;r.table.showdown=false;r.table.version++;r.table.results=[];for(let i=0;i<r.table.max;i++)if(r.table.players[i]?.leaving)r.table.cashout(i);}
 function closeRoom(r){endHand(r);for(let i=0;i<r.table.max;i++)r.table.cashout(i);settle();rooms.delete(r.id);}
 const error=(message,status=400)=>Object.assign(Error(message),{status});
 const int=(v,min,max)=>{v=Number(v);if(!Number.isSafeInteger(v)||v<min||v>max)throw error(`数值范围为 ${min}～${max}`);return v;};
 const text=(v,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw error('文字长度无效');return v.trim();};
 function permitted(n){const a=accounts[n];return !!a&&a.type!=='bot'&&a.status!=='pending'&&!a.blocked&&a.holdemEnabled===true;}
 function user(req){const n=authorize(req)?.username;if(!n)throw error('请先登录',401);if(!permitted(n))throw error('德州扑克权限未开通或已停用',403);seen.set(n,Date.now());return n;}
 function room(req,n){const r=rooms.get(req.params.id);if(!r)throw error('房间不存在',404);if(!r.members.has(n))throw error('请先进入房间',403);return r;}
 const detail=r=>({id:r.id,name:r.name,owner:r.owner,createdAt:r.createdAt,members:r.members.size,max:r.table.max,players:r.table.players.filter(Boolean).length,phase:r.table.phase,hand:r.table.hand,sb:r.table.sb,bb:r.table.bb});
 function view(r,n){settle();const v=r.table.view(n);return {...detail(r),...v,wallet:wallet(n),version:r.table.version,viewerName:n,members:[...r.members].filter(n=>accounts[n]).map(username=>({username,...profile(username),online:Date.now()-(seen.get(username)||0)<15000})),players:v.players.map(p=>p?{...p,...profile(p.id),username:p.id,online:Date.now()-(seen.get(p.id)||0)<15000,connected:Date.now()-(seen.get(p.id)||0)<15000}:null),chat:r.chat.map(m=>({...m,...profile(m.name)})),muted:r.muted,canModerate:r.owner===n||!!accounts[n]?.admin,serverTime:Date.now()};}
 function owner(req,r,n){if(r.owner!==n&&!isAdmin(req))throw error('只有房主或管理员可以操作',403);}
 function mutation(n){if(!groupCan(n,'play'))throw error('你所在分组已暂停下棋功能',403);const b=limits.get(n)||{time:Date.now(),count:0};if(Date.now()-b.time>60000){b.time=Date.now();b.count=0;}limits.set(n,b);if(++b.count>180)throw error('请求过于频繁',429);}
 const route=(method,url,fn)=>app[method](url,async(req,res)=>{try{res.set('Cache-Control','no-store');if(method==='get'){syncDay();fn(req,res);return;}if(fn.constructor.name==='AsyncFunction'){await fn(req,res);return;}let body,status=200;const reply={json:value=>{body=value;return reply;},status:value=>{status=value;return reply;}};transaction(()=>fn(req,reply));res.status(status).json(body);}catch(e){res.status(e.status||400).json({error:e.message});}});
 route('get','/api/holdem/wallet',(req,res)=>{const n=user(req);res.json({...wallet(n),config:bank.config});});
 route('get','/api/holdem/standings',(req,res)=>{user(req);res.json(Object.keys(bank.wallets).filter(n=>accounts[n]&&accounts[n].type!=='bot'&&accounts[n].status!=='pending').map(username=>({username,...profile(username),...wallet(username)})).sort((a,b)=>b.total-a.total||a.username.localeCompare(b.username)).map((v,i)=>({position:i+1,...v})));});
 route('get','/api/holdem/rooms',(req,res)=>{user(req);res.json([...rooms.values()].map(detail));});
 route('post','/api/holdem/rooms',(req,res)=>{
  const n=user(req);mutation(n);const quota=canCreateRoom(n);if(!quota.ok)throw error(quota.error,403);if(rooms.size>=100)throw error('房间数量已满');const b=req.body||{},max=int(b.max??6,2,9),stack=int(b.stack??2000,200,100000),sb=int(b.sb??10,1,1000),time=int(b.time??30,10,120);if(stack<sb*20)throw error('初始筹码至少为大盲的 10 倍');
  const id=crypto.randomBytes(4).toString('hex').toUpperCase(),r={id,name:b.name?text(b.name,40):id,owner:n,createdAt:Date.now(),members:new Set([n]),chat:[],muted:[],table:new Table({max,stack,sb,time})};r.table.funded=true;rooms.set(id,r);save();useRoomQuota(n);res.status(201).json(view(r,n));
 });
 route('get','/api/holdem/rooms/:id',(req,res)=>{const n=user(req);res.json(view(room(req,n),n));});
 route('post','/api/holdem/rooms/:id/join',(req,res)=>{const n=user(req),r=rooms.get(req.params.id);if(!r)throw error('房间不存在',404);if(!r.members.has(n)&&r.members.size>=50)throw error('房间已满');r.members.add(n);save();res.json(view(r,n));});
 route('post','/api/holdem/rooms/:id/action',(req,res)=>{
  const n=user(req),r=room(req,n);mutation(n);const t=r.table,b=req.body||{},p=t.players.find(p=>p?.id===n);
  if(b.op==='seat'){const buyIn=int(b.buyIn??t.stack,Math.max(1,t.bb*10),100000);bank.debit(n,buyIn);t.seat(n,n,int(b.index,0,t.max-1),buyIn);bank.record('buyin',n,[n],buyIn,{room:r.id});}
  else if(b.op==='stand')t.leave(n);
  else if(b.op==='ready'){if(!p||p.leaving)throw error('请先落座');if(!['waiting','finished'].includes(t.phase))throw error('请等待本手结束');if(!p.chips)throw error('筹码不足，请离座后重新买入');p.ready=!p.ready;t.version++;}
  else if(b.op==='start'){owner(req,r,n);t.start();}
  else if(b.op==='bet'){if(b.hand!==t.hand||b.turn!==t.turn||b.version!==t.version)throw error('牌局状态已更新，请重试',409);t.action(n,b.type,b.amount);}
  else if(b.op==='leave'){t.leave(n);r.members.delete(n);if(r.owner===n)r.owner=[...r.members][0]||n;save();return res.json({ok:true});}
  else if(b.op==='kick'){owner(req,r,n);const target=canonicalUsername(b.username);if(target===n)throw error('不能踢出自己');t.leave(target);r.members.delete(target);}
  else if(b.op==='close'){owner(req,r,n);closeRoom(r);save();return res.json({ok:true});}
  else throw error('未知操作');save();res.json(view(r,n));
 });
 function canChat(n,r){if(!groupCan(n,'chat'))throw error('你所在分组已暂停聊天功能',403);if(isGloballyMuted(n)||r.muted.includes(n))throw error('你已被禁言',403);}
 route('post','/api/holdem/rooms/:id/chat',(req,res)=>{const n=user(req),r=room(req,n);canChat(n,r);const value=text(req.body.text,8000),recent=r.chat.at(-1);if(recent?.name===n&&Date.now()-recent.time<700)throw error('请求过于频繁',429);r.chat.push({id:crypto.randomUUID(),name:n,text:value,time:Date.now()});r.chat=r.chat.slice(-100);save();res.json({ok:true});});
 route('post','/api/holdem/rooms/:id/chat-action',(req,res)=>{
  const n=user(req),r=room(req,n),b=req.body||{},m=r.chat.find(m=>m.id===b.id);
  if(b.action==='react'){canChat(n,r);if(!m||m.recalled||!emojis.includes(b.emoji))throw error('无效操作');m.reactions||={};const users=m.reactions[b.emoji]||=[];const i=users.indexOf(n);if(i<0)users.push(n);else users.splice(i,1);if(!users.length)delete m.reactions[b.emoji];}
  else if(b.action==='recall-own'){if(!m||m.name!==n||Date.now()-m.time>300000)throw error('超过 5 分钟，无法撤回');m.text='';m.recalled=true;delete m.reactions;}
  else{owner(req,r,n);if(!['mute','unmute','delete'].includes(b.action))throw error('无效操作');const message=changeChat(r.chat,r.muted,{...b,username:b.username?canonicalUsername(b.username):undefined},isAdmin(req)?3:1,n);if(message)throw error(message);}save();res.json({ok:true});
 });
 route('get','/api/admin/holdem',(req,res)=>{if(!isAdmin(req))throw error('需要管理员权限',403);res.json({config:bank.config,audit:bank.audit.slice(-200).reverse(),accounts:Object.keys(accounts).filter(n=>accounts[n].type!=='bot'&&accounts[n].status!=='pending').map(username=>({username,...profile(username),...(bank.wallets[username]?wallet(username):{balance:0,tableChips:0,committed:0,total:0})})),rooms:[...rooms.values()].map(detail),bytes:fs.existsSync(file)?fs.statSync(file).size:0});});
 route('patch','/api/admin/holdem/settings',(req,res)=>{if(!isAdmin(req))throw error('需要管理员权限',403);bank.configure(req.body.initial,req.body.daily,authorize(req)?.username||'admin-key');res.json({ok:true,config:bank.config});});
 route('post','/api/admin/holdem/chips',(req,res)=>{if(!isAdmin(req))throw error('需要管理员权限',403);const b=req.body||{};if(!Array.isArray(b.usernames)||!b.usernames.length||b.usernames.length>10000)throw error('参数无效');const names=[...new Set(b.usernames.map(canonicalUsername))];bank.grant(names,b.amount,authorize(req)?.username||'admin-key',b.requestId);res.json({ok:true});});
 route('patch','/api/admin/holdem/permissions',async(req,res)=>{
  if(!isAdmin(req))throw error('需要管理员权限',403);const b=req.body||{};if(typeof b.enabled!=='boolean'||!Array.isArray(b.usernames)||!b.usernames.length||b.usernames.length>1000)throw error('参数无效');const names=[...new Set(b.usernames.map(canonicalUsername))];for(const n of names)if(!accounts[n]||accounts[n].type==='bot')throw error('账号不存在或不是玩家账号');
  transaction(()=>bank.syncAll());const previous=names.map(n=>accounts[n].holdemEnabled);for(const n of names)accounts[n].holdemEnabled=b.enabled;try{await saveAccounts.flush();}catch(e){names.forEach((n,i)=>accounts[n].holdemEnabled=previous[i]);throw e;}
  transaction(()=>{for(const n of names){bank.sync(n);if(!b.enabled)remove(n);onAccountChange(n);}});res.json({ok:true});
 });
 route('post','/api/admin/holdem/rooms/:id',(req,res)=>{
  if(!isAdmin(req))throw error('需要管理员权限',403);const r=rooms.get(req.params.id);if(!r)throw error('房间不存在',404);const b=req.body||{};
  if(b.action==='delete')closeRoom(r);
  else if(b.action==='clear-chat')r.chat=[];
  else if(b.action==='end'){endHand(r);r.table.log('管理员已结束比赛');}
  else if(b.action==='chat')return res.json({messages:r.chat.map(m=>({...m,...profile(m.name)})),muted:r.muted});
  else if(b.action==='moderate'){const payload=b.payload||{};if(!['mute','unmute','delete'].includes(payload.action))throw error('无效操作');if(payload.username)payload.username=canonicalUsername(payload.username);const message=changeChat(r.chat,r.muted,payload,3,null);if(message)throw error(message);}
  else throw error('无效操作');save();res.json({ok:true});
 });
 function remove(n){let dirty=false;for(const r of rooms.values())if(r.members.has(n)){r.table.leave(n);r.members.delete(n);if(r.owner===n)r.owner=[...r.members][0]||n;dirty=true;}if(dirty)save();}
 transaction(()=>{bank.syncAll();if(archive?.version!==2)save();});
 synchronizedDay=beijingDay(Date.now());
 const timer=setInterval(()=>{try{syncDay();const now=Date.now();const changed=[...rooms.values()].filter(r=>[...r.members].some(n=>!permitted(n))||(STAGES.includes(r.table.phase)&&r.table.deadline<=now));if(!changed.length)return;transaction(()=>{for(const r of changed){for(const n of [...r.members])if(!permitted(n))remove(n);const t=r.table;if(STAGES.includes(t.phase)&&t.deadline<=now){const p=t.players[t.turn];if(p)t.action(p.id,p.bet>=t.current?'check':'fold');}}});}catch(e){console.error('[holdem]',e.message);}},1000);timer.unref();
 return {rooms,remove:n=>transaction(()=>remove(n)),canEnter:(n,s)=>s.startsWith('holdem:')&&permitted(n)&&!!rooms.get(s.slice(7))?.members.has(n),isMuted:(n,s)=>isGloballyMuted(n)||!!rooms.get(s.slice(7))?.muted.includes(n),close:()=>clearInterval(timer)};
}
