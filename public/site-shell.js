import '/secure.js';
import {language,setLanguage,localize,translateText} from './i18n.js';
import {colorRating, colorUnrated} from './rating-colors.js';
const pokerRoom=/^\/(?:ddz|holdem)\/room\//.test(location.pathname);
const ddzSite=/^\/ddz(?:\/|$)/.test(location.pathname);
const holdemSite=/^\/holdem(?:\/|$)/.test(location.pathname);
function currentTheme(){return localStorage.getItem('junqi-theme')==='light'?'light':'dark';}
let lightFavicon=null,faviconGeneration=0;
function faviconLinks(){let links=[...document.querySelectorAll('link[rel~="icon"]')];if(!links.length){const link=document.createElement('link');link.rel='icon';link.type='image/png';document.head.append(link);links=[link];}return links;}
function applyFavicon(){
  const light=currentTheme()==='light',generation=++faviconGeneration,links=faviconLinks();
  if(holdemSite||ddzSite){for(const link of links)link.href=ddzSite?'/ddz-icon.svg':'/holdem-icon.svg';return;}
  if(!light){for(const link of links)link.href='/favicon.png?v=286';return;}
  if(lightFavicon){for(const link of links)link.href=lightFavicon;return;}
  const image=new Image();image.onload=()=>{if(generation!==faviconGeneration)return;const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const context=canvas.getContext('2d');context.filter='invert(1)';context.drawImage(image,0,0,128,128);lightFavicon=canvas.toDataURL('image/png');if(currentTheme()==='light')for(const link of faviconLinks())link.href=lightFavicon;};image.src='/favicon.png?v=286';
}
function applyTheme(){document.documentElement.classList.toggle('theme-light',currentTheme()==='light');document.documentElement.style.colorScheme=currentTheme();applyFavicon();}
applyTheme();
const header=document.createElement('header');header.className='site-header';
header.innerHTML='<div class="site-top"><a class="site-brand" href="/"><img src="/favicon.png?v=286" alt=""><strong>四国军棋</strong></a><div class="site-account"></div></div><nav class="site-nav" aria-label="主导航"></nav><div class="site-game-tools" hidden></div>';
document.body.prepend(header);
if(holdemSite||ddzSite){document.body.classList.add('holdem-page');header.querySelector('.site-brand img').src=ddzSite?'/ddz-icon.svg':'/holdem-icon.svg';header.querySelector('.site-brand strong').textContent=ddzSite?'斗地主':'德州扑克';}
const links=[['首页','/'],['比赛','/contests.html'],['Rating 排名','/ratings.html'],['分组','/groups.html'],['BOT 列表','/bots.html'],['规则','/rules.html'],['API','/bot-api.html'],['广告','/advertisement.html']];
function readAuth(){try{return JSON.parse(localStorage.getItem('junqi-auth')||'null');}catch{return null;}}
function link(text,href){const a=document.createElement('a');a.href=href;a.textContent=text;return a;}
function render(){
  const auth=readAuth(),actions=header.querySelector('.site-account'),nav=header.querySelector('.site-nav');actions.replaceChildren();nav.replaceChildren();
  const languageChoice=document.createElement('span');languageChoice.className='language-switch';languageChoice.dataset.noI18n='';
  for(const [value,label]of [['zh','中文'],['en','English']]){const button=document.createElement('button');button.type='button';button.className='text-action';button.textContent=label;button.lang=value;button.setAttribute('aria-pressed',String(language()===value));button.onclick=()=>setLanguage(value);languageChoice.append(button);}
  actions.append(languageChoice);
  if(auth?.accountType==='bot'&&location.pathname!=='/bot-studio.html'){document.body.style.visibility='hidden';location.replace('/bot-studio.html');return;}
  header.querySelector('.site-brand').href=auth?.accountType==='bot'?'/bot-studio.html':ddzSite?'/ddz/contest':holdemSite?'/holdem/contest':'/';
  const themeButton=document.createElement('button');themeButton.type='button';themeButton.className='text-action theme-toggle';themeButton.textContent=currentTheme()==='light'?'深色模式':'浅色模式';themeButton.setAttribute('aria-pressed',String(currentTheme()==='light'));themeButton.onclick=()=>{localStorage.setItem('junqi-theme',currentTheme()==='light'?'dark':'light');applyTheme();window.dispatchEvent(new Event('junqi-theme'));render();};actions.append(themeButton);
  if(auth?.token){
    const rated=auth.ratedGames>0;const name=(rated?colorRating:colorUnrated)(link(auth.username,auth.accountType==='bot'?'/bot-studio.html':'/profile/'+encodeURIComponent(auth.username)),auth.rating);actions.append(name);if(auth.accountType!=='bot')actions.append(link('设置','/settings.html'));
    const logout=document.createElement('button');logout.textContent='退出登录';logout.className='text-action';
    logout.onclick=async()=>{logout.disabled=true;try{const r=await fetch('/api/logout',{method:'POST',headers:{Authorization:`Bearer ${auth.token}`}});if(!r.ok)throw Error('退出失败，请重试');localStorage.removeItem('junqi-auth');sessionStorage.removeItem('junqi-session');location.assign('/');}catch(e){alert(e.message);logout.disabled=false;}};
    actions.append(logout);
    if(auth.blocked){const label=document.createElement('span');label.textContent='已封禁 · 只读';actions.append(label);}
  }else actions.append(link('登录','/login.html?next='+encodeURIComponent(location.pathname)),link('注册','/register.html'));
  for(const [text,url]of auth?.accountType==='bot'?[['BOT 工作台','/bot-studio.html']]:ddzSite?[['四国军棋','/'],...(auth?.holdemEnabled?[['德州扑克','/holdem/contest']]:[]),['比赛','/ddz/contest'],['排名','/ddz/ratings'],['规则','/ddz/rules'],...(auth?.admin?[['管理','/admin.html?game=ddz']]:[])]:holdemSite?[['四国军棋','/'],['斗地主','/ddz/contest'],['比赛','/holdem/contest'],['排名','/holdem/ratings'],['规则','/holdem/rules'],...(auth?.admin?[['管理','/admin.html?game=holdem']]:[])]:[...links,['斗地主','/ddz/contest'],...(auth?.holdemEnabled?[['德州扑克','/holdem/contest']]:[]),...(auth?.admin?[['管理','/admin.html']]:[])]){
    const a=link(text,url);if(location.pathname===url||(url==='/contests.html'&&location.pathname.startsWith('/room/'))||(url==='/ddz/contest'&&location.pathname.startsWith('/ddz/room/'))||(url==='/holdem/contest'&&location.pathname.startsWith('/holdem/room/')))a.setAttribute('aria-current','page');nav.append(a);
  }
  document.body.classList.toggle('contests-page',location.pathname==='/contests.html');
  document.body.classList.toggle('room-page',pokerRoom||location.pathname.startsWith('/room/'));document.body.classList.toggle('poker-room-page',pokerRoom);
  const rooms=document.querySelector('.room-browser'),destination=document.querySelector(location.pathname==='/contests.html'?'#contest-main':'#home-sidebar');
  if(rooms&&destination&&rooms.parentElement!==destination)destination.append(rooms);
  const profile=document.querySelector('#home-profile');
  const prompt=document.querySelector('#contest-login');if(prompt)prompt.hidden=!!auth?.token;
  if(profile){profile.replaceChildren();if(auth?.token){const rated=auth.ratedGames>0;const name=(rated?colorRating:colorUnrated)(link(auth.username,'/profile/'+encodeURIComponent(auth.username)),auth.rating);const details=document.createElement('p');details.textContent=auth.accountType==='bot'?'BOT 账号':rated?`${auth.rank} · ${auth.rating}`:'unrated';profile.append(name,details);}else profile.append(link('登录','/login.html'),document.createTextNode(' / '),link('注册','/register.html'));}
}
render();window.addEventListener('junqi-profile-refresh',render);window.addEventListener('junqi-page-change',render);window.addEventListener('storage',event=>{if(event.key==='junqi-theme')applyTheme();render();});
window.addEventListener('junqi-language',()=>{render();localize(header);});
const footer=document.createElement('footer');footer.className='site-footer';footer.innerHTML='<p><a href="https://junqi.bitbybit.dpdns.org">四国军棋</a> Copyright (C) 2026 <a href="https://bitbybit.dpdns.org" data-no-i18n>BitByBit</a></p><p><a href="https://github.com/BitByBitG/siguo-junqi">项目源码</a></p><p><span>系统时间：</span><time data-no-i18n></time></p>';if(holdemSite||ddzSite){const brand=footer.querySelector('a');brand.href=ddzSite?'/ddz/contest':'/holdem/contest';brand.textContent=ddzSite?'斗地主':'德州扑克';}document.body.append(footer);
let serverOffset=null;const clock=footer.querySelector('time');
function updateClock(){if(serverOffset===null){clock.textContent='—';return;}const date=new Date(Date.now()+serverOffset);clock.dateTime=date.toISOString();clock.textContent=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date)+' (UTC+8)';}
async function syncClock(){try{const start=Date.now(),response=await fetch('/api/time',{cache:'no-store'});if(!response.ok)return;const {serverTime}=await response.json();if(Number.isFinite(serverTime))serverOffset=serverTime-(start+Date.now())/2;}catch{}updateClock();}
syncClock();setInterval(updateClock,1000);setInterval(syncClock,60000);
let documentGeneration=0;const originalDocument=document.querySelector('main.document-shell')?.innerHTML;
async function localizeDocument(){
  const generation=++documentGeneration;const names={'/rules.html':'rules','/bot-api.html':'bot-api'};const name=names[location.pathname];if(!name)return;const main=document.querySelector('main.document-shell');if(!main)return;
  if(language()==='zh'){main.innerHTML=originalDocument;localize(main);return;}
  try{const response=await fetch(`/locales/en/${name}.html`);if(!response.ok)throw Error('English document unavailable');const html=await response.text();if(generation===documentGeneration&&language()==='en')main.innerHTML=html;}catch(error){console.error(error);}
}
window.addEventListener('junqi-language',localizeDocument);localizeDocument();localize();
let sidebarRevision=0;
async function sidebar(){
  const revision=++sidebarRevision;
  const top=document.querySelector('#top-rating');if(!top)return;
  try{
    const r=await fetch('/api/ratings');if(!r.ok)throw Error();const users=(await r.json()).slice(0,10);top.replaceChildren();
    users.forEach((u,i)=>{const tr=document.createElement('tr');const rated=u.ratedGames>0;[i+1,u.username,rated?u.rating:'unrated'].forEach((value,j)=>{const td=document.createElement('td');td.textContent=value;if(j===1){td.replaceChildren((rated?colorRating:colorUnrated)(link(value,'/profile/'+encodeURIComponent(u.username)),u.rating));}else if(j===2&& !rated)colorUnrated(td);tr.append(td);});top.append(tr);});
    if(!users.length)top.innerHTML='<tr><td colspan="3">暂无排名</td></tr>';
  }catch{top.innerHTML='<tr><td colspan="3">排名加载失败</td></tr>';}
}
sidebar();window.addEventListener('junqi-profile-refresh',sidebar);setInterval(()=>{if(!document.hidden)sidebar();},15000);
const login=document.querySelector('#site-login-form');
if(login)login.onsubmit=async e=>{
  e.preventDefault();const button=login.querySelector('button'),result=document.querySelector('#login-result');button.disabled=true;
  try{const data=Object.fromEntries(new FormData(login));const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const body=await r.json();if(!r.ok)throw Error(body.error);localStorage.setItem('junqi-auth',JSON.stringify(body));const next=new URLSearchParams(location.search).get('next');location.assign(next&&/^\/(?!\/)/.test(next)&&!next.includes('\\')&&!next.startsWith('/login.html')?next:body.accountType==='bot'?'/bot-studio.html':'/');}catch(e){result.textContent=e.message;button.disabled=false;}
};
if(document.querySelector('#bots-body')){
    const load=async()=>{const tbody=document.querySelector('#bots-body');try{const r=await fetch('/api/bots');if(!r.ok)throw Error('加载失败');const bots=await r.json();tbody.replaceChildren();for(const b of bots.sort((a,b)=>b.rating-a.rating)){const row=document.createElement('tr');const name=document.createElement('td');name.append(colorRating(link(b.username,'/profile/'+encodeURIComponent(b.username)),b.rating));row.append(name);for(const value of [b.rating,b.runtimeMode==='server'?'服务器托管':b.runtimeMode==='external'?'本地/外部':b.runtimeMode==='mixed'?'混合连接':'离线',b.seats,`${(b.localTurnLimitMs||5000)/1000} 秒`,`${(b.serverTurnLimitMs||5000)/1000} 秒`]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}tbody.append(row);}if(!bots.length)tbody.innerHTML='<tr><td colspan="6">暂无 BOT</td></tr>';}catch(e){tbody.textContent=e.message;}};load();setInterval(()=>{if(!document.hidden)load();},10000);
}
if(!document.querySelector('#game-screen')&&readAuth()?.token){const token=readAuth().token;fetch('/api/me',{headers:{Authorization:`Bearer ${token}`}}).then(async r=>{if(readAuth()?.token!==token)return;if(r.ok)localStorage.setItem('junqi-auth',JSON.stringify(await r.json()));else if(r.status===401)localStorage.removeItem('junqi-auth');render();}).catch(()=>{});}
