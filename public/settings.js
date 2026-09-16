import '/secure.js';
const form=document.querySelector('#avatar-form'),result=document.querySelector('#avatar-result');
const options=document.querySelector('#preference-options'),notice=document.querySelector('#preference-result');
const prefs=[['开启 @ 提醒','junqi-mention-notifications'],['开启走棋提醒','junqi-turn-notifications'],['对局隐蔽模式','junqi-stealth'],['显示聊天头像','junqi-chat-avatars',true]];
for(const [title,key,defaultOn]of prefs){
  const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=defaultOn?localStorage.getItem(key)!=='0':localStorage.getItem(key)==='1';label.append(input,document.createTextNode(title));options.append(label);
  input.onchange=async()=>{const enabled=input.checked;input.disabled=true;try{
    if(enabled&&key.includes('notifications')){if(!window.isSecureContext||!('Notification'in window))throw Error('当前浏览器不支持通知，请使用 HTTPS 并检查浏览器权限');if(await Notification.requestPermission()!=='granted')throw Error('通知权限未开启，请在浏览器的网站权限中允许通知');}
    localStorage.setItem(key,enabled?'1':'0');notice.textContent='已保存，适用于当前浏览器。';window.dispatchEvent(new Event('junqi-preferences'));
  }catch(e){input.checked=!enabled;notice.textContent=e.message;}finally{input.disabled=false;}};
  window.addEventListener('storage',e=>{if(e.key===key)input.checked=defaultOn?e.newValue!=='0':e.newValue==='1';});
}
document.querySelector('#reset-avatar').onclick=async e=>{
  const button=e.currentTarget;button.disabled=true;
  try{const auth=JSON.parse(localStorage.getItem('junqi-auth')||'null');const r=await fetch('/api/avatar',{method:'DELETE',headers:{Authorization:'Bearer '+(auth?.token||'')}});const body=await r.json();if(!r.ok)throw Error(body.error);result.textContent='已恢复默认头像，旧头像已删除。';}catch(e){result.textContent=e.message;}finally{button.disabled=false;}
};
form.onsubmit=async e=>{
  e.preventDefault();const button=form.querySelector('button');button.disabled=true;
  try{
    const auth=JSON.parse(localStorage.getItem('junqi-auth')||'null');if(!auth?.token)throw Error('请先登录');
    const file=form.querySelector('input').files[0];if(!file||file.size>4*1024*1024)throw Error('请选择不超过 4 MiB 的图片');
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(file);});
    const r=await fetch('/api/avatar',{method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${auth.token}`},body:JSON.stringify({data})});const body=await r.json();if(!r.ok)throw Error(body.error);
    result.replaceChildren(document.createTextNode('头像已保存。'));const a=document.createElement('a');a.href='/profile/'+encodeURIComponent(auth.username);a.textContent='查看主页';result.append(a);form.reset();
  }catch(e){result.textContent=e.message;}finally{button.disabled=false;}
};
