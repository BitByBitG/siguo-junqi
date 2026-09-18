import '/secure.js';
import {colorRating} from './rating-colors.js';
import {avatarImage} from './avatars.js';
import {renderRichChatBody} from './chat-common.js';
for(const src of ['/vendor/marked/marked.umd.js','/vendor/dompurify/purify.min.js','/vendor/katex/katex.min.js','/vendor/katex/contrib/auto-render.min.js'])if(!document.querySelector(`script[src="${src}"]`))await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.append(s);});
const $=s=>document.querySelector(s);let username=decodeURIComponent(location.pathname.split('/').at(-1));
const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
const link=(text,href)=>{const el=node('a',text);el.href=href;return el;};
const date=time=>new Date(time).toLocaleString();
function chart(history,current){
  const entries=history.length?[{after:history[0].before,time:history[0].time},...history]:[{after:current,time:Date.now()}];
  const host=$('#rating-chart'),hint=node('p','点击图表后可滚轮缩放；按住拖动可左右平移，按 Esc 退出。');hint.className='rating-chart-hint';
  const fullEnd=Math.max(1,entries.length-1),minimumSpan=Math.min(fullEnd,Math.max(.25,fullEnd/100));let viewStart=0,viewEnd=fullEnd,active=false,drag=null;
  const fullMin=Math.min(7600,Math.max(-100,Math.floor((Math.min(...entries.map(p=>p.after))-150)/100)*100)),fullMax=Math.min(8000,Math.max(fullMin+400,Math.ceil((Math.max(...entries.map(p=>p.after))+150)/100)*100));let viewMin=fullMin,viewMax=fullMax;
  const normalizeX=(start,end)=>{const span=Math.min(fullEnd,Math.max(minimumSpan,end-start));start=Math.max(0,Math.min(fullEnd-span,start));return [start,start+span];};
  const normalizeY=(min,max)=>{const span=Math.min(fullMax-fullMin,Math.max(50,max-min));min=Math.max(fullMin,Math.min(fullMax-span,min));return [min,min+span];};
  const draw=()=>{
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 960 320');svg.setAttribute('role','img');svg.setAttribute('aria-label','Rating 变化折线图；点击后可使用滚轮缩放，拖动可平移');
    const add=(parent,tag,attrs,text)=>{const el=document.createElementNS(svg.namespaceURI,tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;parent.append(el);return el;};
    const x=i=>65+(i-viewStart)/(viewEnd-viewStart)*865,y=r=>275-(r-viewMin)/(viewMax-viewMin)*240;
    for(const [lo,hi,fill]of [[-100,1200,'#cccccc'],[1200,1400,'#77ff77'],[1400,1600,'#77ddbb'],[1600,1900,'#aaaaff'],[1900,2100,'#ff88ff'],[2100,2400,'#ffcc88'],[2400,2600,'#ff7777'],[2600,3000,'#ff3333'],[3000,10000,'#aa0000']]){const a=Math.max(lo,viewMin),b=Math.min(hi,viewMax);if(b>a)add(svg,'rect',{x:65,y:y(b),width:865,height:y(a)-y(b),fill});}
    for(let i=0;i<=8;i++)add(svg,'line',{x1:65+i*865/8,x2:65+i*865/8,y1:35,y2:275,stroke:'#777777','stroke-opacity':.35,'stroke-width':.7});
    for(const r of [...new Set([Math.round(viewMin),Math.round(viewMax),...[1200,1400,1600,1900,2100,2400,2600,3000].filter(r=>r>viewMin&&r<viewMax)])]){add(svg,'line',{x1:65,x2:930,y1:y(r),y2:y(r),stroke:'#59616b','stroke-width':.6});add(svg,'text',{x:54,y:y(r)+5,'text-anchor':'end',fill:'#aeb7c2','font-size':14},r);}
    const defs=add(svg,'defs',{}),clip=add(defs,'clipPath',{id:'rating-plot-clip'});add(clip,'rect',{x:65,y:35,width:865,height:240});
    const plot=add(svg,'g',{'clip-path':'url(#rating-plot-clip)'});add(plot,'polyline',{points:entries.map((p,i)=>`${x(i)},${y(p.after)}`).join(' '),fill:'none',stroke:'#f5ce45','stroke-width':2});
    entries.forEach((p,i)=>{if(i<Math.floor(viewStart)||i>Math.ceil(viewEnd))return;const dot=add(plot,'circle',{cx:x(i),cy:y(p.after),r:3.7,fill:'#ffffff',stroke:i===entries.length-1?'#ed2525':'#f5ce45','stroke-width':1.8,tabindex:0});const title=document.createElementNS(svg.namespaceURI,'title');title.textContent=`${i===0?'初始':p.name||p.code} · ${date(p.time)} · Rating ${p.after}`;dot.append(title);});
    add(svg,'text',{x:65,y:305,fill:'#aeb7c2','font-size':14},history.length?'首场记录':'当前');add(svg,'text',{x:930,y:305,'text-anchor':'end',fill:'#aeb7c2','font-size':14},`共 ${history.length} 场记录`);
    add(svg,'rect',{x:930-Math.max(90,username.length*9+24),y:39,width:Math.max(90,username.length*9+24),height:19,fill:'#2d333b','fill-opacity':.45,stroke:'#e5e5e5','stroke-width':.7});add(svg,'rect',{x:935-Math.max(90,username.length*9+24),y:43,width:12,height:11,fill:'#f5ce45',stroke:'#ffffff'});add(svg,'text',{x:925,y:53,'text-anchor':'end',fill:'#ffffff','font-size':13},username);
    host.replaceChildren(svg,hint);
  };
  const fractions=event=>{const rect=host.querySelector('svg').getBoundingClientRect(),vx=(event.clientX-rect.left)/rect.width*960,vy=(event.clientY-rect.top)/rect.height*320;return {x:Math.max(0,Math.min(1,(vx-65)/865)),y:Math.max(0,Math.min(1,(vy-35)/240)),rect};};
  host.tabIndex=0;host.addEventListener('click',()=>{active=true;host.classList.add('is-active');host.focus({preventScroll:true});});
  host.addEventListener('keydown',event=>{if(event.key==='Escape'){active=false;drag=null;host.classList.remove('is-active','is-dragging');}});
  host.addEventListener('wheel',event=>{if(!active)return;event.preventDefault();const f=fractions(event),factor=event.deltaY<0?.8:1.25,xSpan=viewEnd-viewStart,ySpan=viewMax-viewMin,xPoint=viewStart+f.x*xSpan,yPoint=viewMax-f.y*ySpan,newX=xSpan*factor,newY=ySpan*factor;[viewStart,viewEnd]=normalizeX(xPoint-f.x*newX,xPoint+(1-f.x)*newX);[viewMin,viewMax]=normalizeY(yPoint-(1-f.y)*newY,yPoint+f.y*newY);draw();},{passive:false});
  host.addEventListener('pointerdown',event=>{if(!active||event.button!==0)return;const f=fractions(event);drag={x:event.clientX,y:event.clientY,start:viewStart,end:viewEnd,min:viewMin,max:viewMax,width:f.rect.width*865/960,height:f.rect.height*240/320};host.setPointerCapture?.(event.pointerId);host.classList.add('is-dragging');});
  host.addEventListener('pointermove',event=>{if(!drag)return;const shiftX=-(event.clientX-drag.x)/drag.width*(drag.end-drag.start),shiftY=(event.clientY-drag.y)/drag.height*(drag.max-drag.min);[viewStart,viewEnd]=normalizeX(drag.start+shiftX,drag.end+shiftX);[viewMin,viewMax]=normalizeY(drag.min+shiftY,drag.max+shiftY);draw();});
  const stopDrag=()=>{drag=null;host.classList.remove('is-dragging');};host.addEventListener('pointerup',stopDrag);host.addEventListener('pointercancel',stopDrag);
  draw();
}
try{
  const response=await fetch('/api/profile/'+encodeURIComponent(username));const user=await response.json();if(!response.ok)throw Error(user.error);username=user.username;
  document.title=username+' · 四国军棋';$('#profile-name').textContent=username;colorRating($('#profile-name'),user.rating);
  $('#profile-rank').textContent=user.rank;colorRating($('#profile-rank'),user.rating);
  const signatureSection=document.createElement('section'),signatureTitle=node('h2','个性签名'),signature=node('div');signature.className='profile-signature chat-content';signatureSection.append(signatureTitle,signature);$('#profile-info').after(signatureSection);renderRichChatBody(signature,user.signature||'');
  for(const [key,value]of [['类型',user.accountType==='bot'?'BOT':'玩家'],['Rating',user.rating],['最高 Rating',user.peakRating],['计分场次',user.ratedGames],...(user.createdAt?[['注册时间',date(user.createdAt)]]:[])])$('#profile-details').append(node('dt',key),node('dd',value));
  let auth;try{auth=JSON.parse(localStorage.getItem('junqi-auth'));}catch{}$('#own-settings').hidden=auth?.username!==username;
  chart(user.history,user.rating);if(!user.history.length)$('#chart-empty').textContent='暂无记录';
  for(const h of [...user.history].reverse()){const tr=node('tr'),cell=node('td');cell.append(h.code?link(h.name||h.code,'/room/'+h.code):node('span',h.name||'分数调整'));tr.append(node('td',date(h.time)),cell,node('td',(h.delta>0?'+':'')+h.delta),colorRating(node('td',h.after),h.after));$('#rating-history').append(tr);}
  for(const c of user.contests){const row=node('p');row.append(link(c.name,'/room/'+c.code),node('span',` · ${c.winner||'已结束'} · ${c.rated?'Rated':'不计分'}`));$('#profile-contests').append(row);}if(!user.contests.length)$('#profile-contests').textContent='暂无比赛记录';
  $('#avatar-box').replaceChildren(avatarImage(username,user.avatar));
}catch(e){$('#profile-name').textContent='用户主页';$('#profile-error').textContent=e.message;}
