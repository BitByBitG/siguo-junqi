import '/secure.js';
import {colorRating} from './rating-colors.js';
const header=document.createElement('header');header.className='site-header';
header.innerHTML='<div class="site-top"><a class="site-brand" href="/"><img src="/favicon.png?v=240" alt=""><strong>四国军棋</strong></a><div class="site-account"></div></div><nav class="site-nav" aria-label="主导航"></nav><div class="site-game-tools" hidden></div>';
document.body.prepend(header);
const links=[['首页','/'],['比赛','/contests.html'],['Rating 排名','/ratings.html'],['分组','/groups.html'],['BOT 列表','/bots.html'],['规则','/rules.html'],['API','/bot-api.html'],['广告','/advertisement.html']];
const stealthButton=document.querySelector('#stealth-button');
function readAuth(){try{return JSON.parse(localStorage.getItem('junqi-auth')||'null');}catch{return null;}}
function link(text,href){const a=document.createElement('a');a.href=href;a.textContent=text;return a;}
function render(){
  const auth=readAuth(),actions=header.querySelector('.site-account'),nav=header.querySelector('.site-nav');actions.replaceChildren();nav.replaceChildren();
  if(auth?.accountType==='bot'&&location.pathname!=='/bot-studio.html'){document.body.style.visibility='hidden';location.replace('/bot-studio.html');return;}
  header.querySelector('.site-brand').href=auth?.accountType==='bot'?'/bot-studio.html':'/';
  if(auth?.token){
    const name=colorRating(link(auth.username,auth.accountType==='bot'?'/bot-studio.html':'/profile/'+encodeURIComponent(auth.username)),auth.rating);actions.append(name);if(auth.accountType!=='bot')actions.append(link('设置','/settings.html'));
    const logout=document.createElement('button');logout.textContent='退出登录';logout.className='text-action';
    logout.onclick=async()=>{logout.disabled=true;try{const r=await fetch('/api/logout',{method:'POST',headers:{Authorization:`Bearer ${auth.token}`}});if(!r.ok)throw Error('退出失败，请重试');localStorage.removeItem('junqi-auth');sessionStorage.removeItem('junqi-session');location.assign('/');}catch(e){alert(e.message);logout.disabled=false;}};
    actions.append(logout);
    if(auth.blocked){const label=document.createElement('span');label.textContent='已封禁 · 只读';actions.append(label);}
  }else actions.append(link('登录','/login.html?next='+encodeURIComponent(location.pathname)),link('注册','/register.html'));
  if(stealthButton){const game=document.querySelector('#game-screen'),tools=header.querySelector('.site-game-tools');tools.hidden=!game||game.classList.contains('hidden');tools.append(stealthButton);}
  for(const [text,url]of auth?.accountType==='bot'?[['BOT 工作台','/bot-studio.html']]:[...links,...(auth?.admin?[['管理','/admin.html']]:[])]){
    const a=link(text,url);if(location.pathname===url||(url==='/contests.html'&&location.pathname.startsWith('/room/')))a.setAttribute('aria-current','page');nav.append(a);
  }
  document.body.classList.toggle('contests-page',location.pathname==='/contests.html');
  document.body.classList.toggle('room-page',location.pathname.startsWith('/room/'));
  const rooms=document.querySelector('.room-browser'),destination=document.querySelector(location.pathname==='/contests.html'?'#contest-main':'#home-sidebar');
  if(rooms&&destination&&rooms.parentElement!==destination)destination.append(rooms);
  const profile=document.querySelector('#home-profile');
  const prompt=document.querySelector('#contest-login');if(prompt)prompt.hidden=!!auth?.token;
  if(profile){profile.replaceChildren();if(auth?.token){const name=colorRating(link(auth.username,'/profile/'+encodeURIComponent(auth.username)),auth.rating);const details=document.createElement('p');details.textContent=auth.accountType==='bot'?'BOT 账号':`${auth.rank} · ${auth.rating}`;profile.append(name,details);}else profile.append(link('登录','/login.html'),document.createTextNode(' / '),link('注册','/register.html'));}
}
render();window.addEventListener('junqi-profile-refresh',render);window.addEventListener('junqi-page-change',render);window.addEventListener('storage',render);
let sidebarRevision=0;
async function sidebar(){
  const revision=++sidebarRevision;
  const top=document.querySelector('#top-rating');if(!top)return;
  try{
    const r=await fetch('/api/ratings');if(!r.ok)throw Error();const users=(await r.json()).slice(0,10);top.replaceChildren();
    users.forEach((u,i)=>{const tr=document.createElement('tr');[i+1,u.username,u.rating].forEach((value,j)=>{const td=document.createElement('td');td.textContent=value;if(j===1){td.replaceChildren(colorRating(link(value,'/profile/'+encodeURIComponent(u.username)),u.rating));}tr.append(td);});top.append(tr);});
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
    const load=async()=>{const tbody=document.querySelector('#bots-body');try{const r=await fetch('/api/bots');if(!r.ok)throw Error('加载失败');const bots=await r.json();tbody.replaceChildren();for(const b of bots.sort((a,b)=>b.rating-a.rating)){const row=document.createElement('tr');const name=document.createElement('td');name.append(colorRating(link(b.username,'/profile/'+encodeURIComponent(b.username)),b.rating));row.append(name);for(const value of [b.rating,b.online?'在线':'离线',b.seats]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}tbody.append(row);}if(!bots.length)tbody.innerHTML='<tr><td colspan="4">暂无 BOT</td></tr>';}catch(e){tbody.textContent=e.message;}};load();setInterval(()=>{if(!document.hidden)load();},10000);
}
if(!document.querySelector('#game-screen')&&readAuth()?.token){const token=readAuth().token;fetch('/api/me',{headers:{Authorization:`Bearer ${token}`}}).then(async r=>{if(readAuth()?.token!==token)return;if(r.ok)localStorage.setItem('junqi-auth',JSON.stringify(await r.json()));else if(r.status===401)localStorage.removeItem('junqi-auth');render();}).catch(()=>{});}
