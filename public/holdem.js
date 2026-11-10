import './secure.js';
import {pokerPlayerCard,emptyPlayerCard,renderPokerSpectators,settlementPanel} from './poker-room-ui.js';
import {showToast} from './toast.js';
import {language,translateText,localize} from './i18n.js';
import {mountRoomChat} from './shared-room-chat.js';
import {colorRating,colorUnrated} from './rating-colors.js';
const $=s=>document.querySelector(s),t=s=>translateText(s,language());
const readAuth=()=>{try{return JSON.parse(localStorage.getItem('junqi-auth')||'null');}catch{return null;}};
let auth=readAuth(),state=null,chat=null,polling=false,busy=false,renderKey='',lastNotification='',clockOffset=0;
const roomId=location.pathname.match(/^\/holdem\/room\/([A-Za-z0-9]+)\/?$/)?.[1];
const standingsPage=/\/holdem\/ratings\/?$/.test(location.pathname);
function renderWallet(w){$('#holdem-wallet').textContent=t('可用筹码')+': '+w.balance+' · '+t('牌桌筹码')+': '+w.tableChips+' · '+t('已下注筹码')+': '+w.committed+' · '+t('总筹码')+': '+w.total;}
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function status(error){if(error?.message||error)showToast(t(error?.message||String(error)));}
async function request(url,body,method=body===undefined?'GET':'POST'){
 const r=await fetch(url,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+(auth?.token||'')},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store'});const b=await r.json();if(!r.ok){const e=Object.assign(Error(b.error||'请求失败'),{status:r.status});throw e;}return b;
}
function nameLink(p){const a=node('a',p.username||p.name);a.href='/profile/'+encodeURIComponent(p.username||p.name);a.dataset.username=p.username||p.name;(p.ratedGames>0?colorRating:colorUnrated)(a,p.rating);return a;}
function card(value){const e=node('span',undefined,'holdem-card');e.dataset.noI18n='';if(value===null){e.classList.add('back');e.textContent='?';return e;}const rank=value%13+2,suit=Math.floor(value/13);e.textContent=(rank<11?rank:['J','Q','K','A'][rank-11])+['♠','♥','♣','♦'][suit];if(suit===1||suit===3)e.classList.add('red');return e;}
function cards(values){const e=node('div',undefined,'holdem-cards');values.forEach(v=>e.append(card(v)));return e;}
function button(text,fn){const e=node('button',text);e.type='button';e.className='secondary-button';e.onclick=fn;return e;}
function path(){return '/api/holdem/rooms/'+encodeURIComponent(roomId);}
async function action(body){if(busy)return;busy=true;try{const result=await request(path()+'/action',body);status('');if(['leave','close'].includes(body.op)){location.assign('/holdem');return;}state=result;renderRoom();}catch(e){status(e);}finally{busy=false;await poll();}}
function safeLog(value){let text=String(value),names=[...new Set((state?.members||[]).map(p=>p.username))].sort((a,b)=>b.length-a.length);const keep=[];for(const n of names){const marker='\u0001'+keep.length+'\u0002';if(text.includes(n)){keep.push(n);text=text.split(n).join(marker);}}if(language()==='en')text=text.replace(/^第 (\d+) 手开始 · 盲注 (.*)$/,'Hand $1 started · Blinds $2');text=t(text);return text.replace(/\u0001(\d+)\u0002/g,(_,i)=>keep[Number(i)]);}
function renderRoom(){
 renderWallet(state.wallet);
 clockOffset=state.serverTime-Date.now();
 $('#holdem-room-name').textContent=state.name;$('#holdem-code').textContent=state.id;$('#holdem-close').hidden=state.owner!==auth.username&&!auth.admin;
 const key=JSON.stringify([state.version,state.players,state.logs,state.results,state.members,state.chipChanges,state.owner,language()]);
 if(key!==renderKey){renderKey=key;const table=$('#holdem-table');table.replaceChildren();const center=node('div',undefined,'holdem-center');center.append(node('p',t('底池')+': '+state.pot),cards(state.board),node('p',t({waiting:'等待准备',preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌',finished:'本手结束'}[state.phase]||state.phase)));table.append(center);
  const myIndex=state.players.findIndex(p=>p?.id===auth.username),rotation=myIndex<0?0:myIndex;
  state.players.forEach((p,i)=>{const angle=Math.PI/2+(i-rotation)*2*Math.PI/state.max,e=node('div',undefined,'holdem-seat'+(i===state.turn?' active':'')+(p?.folded?' folded':''));e.style.left=(50+39*Math.cos(angle))+'%';e.style.top=(50+37*Math.sin(angle))+'%';
   if(!p)e.append(button(t(myIndex<0?'落座':'空位')+' '+(i+1),()=>{const amount=prompt(t('请输入带入筹码'),String(Math.min(state.stack,state.wallet.balance)));if(amount!==null)action({op:'seat',index:i,buyIn:Number(amount)});}));
   else{const box=node('div',undefined,'holdem-seat-box');box.append(nameLink(p),node('div',p.chips+' '+t('筹码')));if(state.button===i)box.append(node('span','D'));e.append(node('div',p.bet?String(p.bet):''),box,cards(p.hole),node('small',p.leaving?t('已离座'):p.ready?t('已准备'):t(p.last||'')));}table.append(e);
  });
  const players=$('#holdem-players');players.replaceChildren();for(const [i,p]of state.players.entries()){if(!p){players.append(emptyPlayerCard(i));continue;}players.append(pokerPlayerCard(p,{active:state.players[state.turn]?.id===p.id,owner:state.owner===p.id,detail:p.chips+' '+t('筹码'),viewer:auth.username,phase:state.phase,change:state.chipChanges?.find(c=>c.id===p.id),kick:state.canModerate&&p.id!==auth.username?()=>{if(confirm(t('移出该玩家？进行中的手牌将弃牌。')))action({op:'kick',username:p.id});}:null}));}
  const controls=$('#holdem-actions');controls.replaceChildren();const me=state.players.find(p=>p?.id===auth.username),waiting=['waiting','finished'].includes(state.phase);
  if(me){controls.append(button('离座观战',()=>{if(waiting||confirm(t('离座会弃掉当前手牌，确定离座？')))action({op:'stand'});}));if(waiting&&!me.leaving)controls.append(button(me.ready?'取消准备':'准备游戏',()=>action({op:'ready'})));}
  if(waiting&&(state.owner===auth.username||auth.admin)){const start=button('开始下一手',()=>action({op:'start'}));start.disabled=state.players.filter(p=>p?.ready).length<2;controls.append(start);}
  if(state.legal){const bet=(type,amount)=>action({op:'bet',type,amount,hand:state.hand,turn:state.turn,version:state.version});controls.append(button('弃牌',()=>bet('fold')),button(state.legal.call?t('跟注')+' '+state.legal.call:'过牌',()=>bet(state.legal.call?'call':'check')));
   const max=state.legal.max,min=state.legal.min;if(state.legal.canRaise&&max>=min){const input=node('input');input.type='number';input.min=min;input.max=max;input.step=1;input.value=min;input.setAttribute('aria-label',t('加注到'));controls.append(input,button('加注到',()=>bet('raise',Number(input.value))));}
   if(max<=state.current||state.legal.canRaise)controls.append(button('全下',()=>{if(confirm(t('确定投入全部剩余筹码？')))bet('allin');}));
  }
  const log=$('#holdem-log');log.dataset.noI18n='';const near=log.scrollHeight-log.scrollTop-log.clientHeight<30,oldTop=log.scrollTop;log.replaceChildren(...state.logs.map(value=>node('p',safeLog(value))));if(state.results.length)log.append(...state.results.map(r=>node('p',r.name+' +'+r.amount+' ('+t(r.label)+')')));for(const h of state.revealedHands||[]){const row=node('div',undefined,'holdem-player');row.append(nameLink(h),cards(h.hole));log.append(row);}log.scrollTop=near?log.scrollHeight:oldTop;localize($('#holdem-room'));
 }
 renderPokerSpectators($('#holdem-spectators'),state,auth.username,state.canModerate?username=>action({op:'kick',username}):null);settlementPanel($('#holdem-settlement'),state.chipChanges,state.members,'筹码变化');chat?.update(state.chat,state.muted,state.canModerate);
 if(state.legal&&localStorage.getItem('junqi-turn-notifications')==='1'&&'Notification'in window&&Notification.permission==='granted'){const n=state.hand+':'+state.version;if(lastNotification!==n){lastNotification=n;try{const notice=new Notification(t('德州扑克：轮到你行动'),{body:state.name,tag:'holdem-turn'});notice.onclick=()=>{window.focus();notice.close();};}catch{}}}
}
async function poll(){if(polling||busy||!auth?.holdemEnabled)return;polling=true;try{if(roomId){state=await request(path());renderRoom();}else{
 const [w,data]=await Promise.all([request('/api/holdem/wallet'),request(standingsPage?'/api/holdem/standings':'/api/holdem/rooms')]);renderWallet(w);
 if(standingsPage){const body=$('#holdem-standings-body');body.replaceChildren();for(const p of data){const row=node('tr'),name=node('td');name.append(nameLink(p));row.append(node('td',p.position),name,...[p.balance,p.tableChips,p.committed,p.total].map(x=>node('td',String(x))));body.append(row);}}
 else{const body=$('#holdem-rooms');body.replaceChildren();for(const r of data){const row=node('tr'),name=node('td'),owner=node('td'),a=node('a',r.name);a.href='/holdem/room/'+r.id;a.dataset.noI18n='';name.append(a);owner.append(nameLink({username:r.owner}));const join=node('td');join.append(button('进入房间',()=>location.assign(a.href)));row.append(name,owner,node('td',r.players+'/'+r.max),node('td',t(r.phase==='waiting'?'即将开始':r.phase==='finished'?'已经结束':'正在进行')),join);body.append(row);}if(!data.length){const row=node('tr'),cell=node('td','暂无房间');cell.colSpan=5;row.append(cell);body.append(row);}localize(body);}
 }}catch(e){status(e);if([401,403,404].includes(e.status)){$('#holdem-room').hidden=true;chat?.destroy();chat=null;}}finally{polling=false;}}
async function start(){
 if(!auth?.token){status('请先登录');const a=node('a','登录');a.href='/login.html?next='+encodeURIComponent(location.pathname);$('#holdem-status').hidden=false;$('#holdem-status').replaceChildren(a);return;}
 try{const me=await request('/api/me');auth=me;localStorage.setItem('junqi-auth',JSON.stringify(me));window.dispatchEvent(new Event('junqi-profile-refresh'));if(!me.holdemEnabled){status('德州扑克权限未开通或已停用');return;}
  if(roomId){state=await request(path()+'/join',{});$('#holdem-room').hidden=false;chat=mountRoomChat($('#holdem-chat'),{auth,scope:'holdem:'+roomId,send:async text=>{await request(path()+'/chat',{text});await poll();},action:async body=>{await request(path()+'/chat-action',body);await poll();},onError:status});renderRoom();}
  else{$(standingsPage?'#holdem-standings':'#holdem-lobby').hidden=false;await poll();}
 }catch(e){status(e);}
}
$('#holdem-create').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;try{const data=Object.fromEntries(new FormData(e.target)),r=await request('/api/holdem/rooms',data);location.assign('/holdem/room/'+r.id);}catch(e){status(e);}finally{busy=false;}};
$('#holdem-refresh').onclick=poll;$('#holdem-leave').onclick=()=>{if(confirm(t('确认离开当前房间吗？')))action({op:'leave'});};$('#holdem-close').onclick=()=>{if(confirm(t('关闭房间将结束当前牌局，确定关闭？')))action({op:'close'});};$('#holdem-invite').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);status('邀请链接已复制');}catch{status(location.href);}};
window.addEventListener('junqi-language',()=>{renderKey='';if(state)renderRoom();else poll();});window.addEventListener('storage',e=>{if(e.key==='junqi-auth'&&!readAuth()?.token)location.assign('/login.html');});
setInterval(()=>{if(state?.deadline){const seconds=Math.max(0,Math.ceil((state.deadline-(Date.now()+clockOffset))/1000));$('#holdem-countdown').textContent=t('剩余秒数')+': '+seconds;}else $('#holdem-countdown').textContent='';},500);
await start();setInterval(()=>{if(!document.hidden)poll();},1200);
setInterval(async()=>{if(!auth?.token)return;try{const me=await request('/api/me');if(me.holdemEnabled!==auth.holdemEnabled){auth=me;localStorage.setItem('junqi-auth',JSON.stringify(me));window.dispatchEvent(new Event('junqi-profile-refresh'));if(!me.holdemEnabled){$('#holdem-room').hidden=$('#holdem-lobby').hidden=true;status('德州扑克权限未开通或已停用');}}}catch{}},10000);
