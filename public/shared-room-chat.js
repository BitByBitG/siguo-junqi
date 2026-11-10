import {renderRichChatBody,attachChatFold,releaseChatFolds} from './chat-common.js';
import {copySourceButton,renderMutedUsers} from './chat-controls.js';
import {avatarImage,messageTime} from './avatars.js';
import {attachImages,composeImages,clearImages} from './chat-images.js';
import {colorRating,colorUnrated} from './rating-colors.js';
import {openEmojiPicker,closeEmojiPicker} from './emoji-picker.js';
import {translateText,language} from './i18n.js';

// Uses the same chat rendering, folding, image cache, avatars and controls as Junqi.
export function mountRoomChat(host,{auth,scope,send,action,onError}){
 host.classList.add('shared-room-chat');
 host.classList.add('chat-panel');host.innerHTML='<div class="panel-heading"><h2>房间聊天</h2><button type="button" class="icon-button chat-expand">放大聊天</button></div><div class="chat-list"></div><div class="chat-muted-users" hidden></div><form class="chat-form"><textarea rows="3" maxlength="8000" placeholder="支持 Markdown、LaTeX 与图片，Ctrl+Enter 发送"></textarea><button type="submit">发送</button></form>';
 const list=host.querySelector('.chat-list'),input=host.querySelector('textarea'),form=host.querySelector('form'),muted=host.querySelector('.chat-muted-users');attachImages(input);
 let key='',initial=true,latest=[],isExpanded=false,canModerate=false;const seen=new Set(),expanded=host.querySelector('.chat-expand');
 expanded.onclick=()=>{isExpanded=!isExpanded;host.classList.toggle('chat-expanded',isExpanded);expanded.textContent=isExpanded?'恢复大小':'放大聊天';expanded.setAttribute('aria-expanded',String(isExpanded));expanded.setAttribute('aria-pressed',String(isExpanded));};
 const mention=document.createElement('button');mention.type='button';mention.className='icon-button';
 function syncMention(){const enabled=localStorage.getItem('junqi-mention-notifications')==='1';mention.textContent=translateText(enabled?'@ 提醒：开':'@ 提醒：关',language());mention.setAttribute('aria-pressed',String(enabled));}
 mention.onclick=async()=>{const enabled=localStorage.getItem('junqi-mention-notifications')==='1';if(!enabled){if(!('Notification'in window)){onError(Error(translateText('浏览器不支持通知',language())));return;}if(Notification.permission!=='granted'&&await Notification.requestPermission()!=='granted')return;}localStorage.setItem('junqi-mention-notifications',enabled?'0':'1');syncMention();};host.querySelector('.panel-heading').append(mention);syncMention();window.addEventListener('junqi-language',syncMention);
 const run=(...args)=>Promise.resolve(action(...args)).catch(onError);
 function button(text,fn){const b=document.createElement('button');b.type='button';b.className='chat-recall';b.textContent=text;b.onclick=fn;return b;}
 function update(messages,mutedUsers=[],moderator=false){
  latest=messages;canModerate=moderator;const next=JSON.stringify([messages,mutedUsers,moderator,language(),localStorage.getItem('junqi-chat-avatars')]);if(next===key)return;key=next;
  const knownIds=new Set([...list.children].map(r=>r.dataset.messageId));
  const nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<36,oldTop=list.scrollTop;
  const old=new Map([...list.children].map(row=>[row.dataset.messageId,row]));const rows=[];
  for(const m of messages){
   const version=JSON.stringify(m),existing=old.get(m.id);if(existing?.dataset.version===version&&existing.dataset.moderator===String(moderator)&&existing.dataset.language===language()){rows.push(existing);old.delete(m.id);continue;}
   if(existing){releaseChatFolds(existing);old.delete(m.id);}const row=document.createElement('article');row.className='chat-item';row.dataset.messageId=m.id;row.dataset.version=version;row.dataset.moderator=String(moderator);row.dataset.language=language();
   const meta=document.createElement('div');meta.className='chat-meta';if(localStorage.getItem('junqi-chat-avatars')!=='0'){const a=document.createElement('a');a.href='/profile/'+encodeURIComponent(m.name);a.append(avatarImage(m.name,m.avatar));meta.append(a);}
   const name=document.createElement('a');name.href='/profile/'+encodeURIComponent(m.name);name.textContent=m.name;name.dataset.username=m.name;(m.ratedGames>0?colorRating:colorUnrated)(name,m.rating);meta.append(name);const time=messageTime(m.time);if(time)meta.append(time);
   const controls=document.createElement('span');controls.className='chat-actions';controls.append(copySourceButton(m.recalled?'':m.text));
   if(!m.recalled){if(m.name===auth.username&&Date.now()-m.time<=300000)controls.append(button('撤回',()=>run({action:'recall-own',id:m.id})));if(moderator){controls.append(button('删除',()=>run({action:'delete',id:m.id})));if(m.name!==auth.username)controls.append(button(mutedUsers.includes(m.name)?'解除禁言':'禁言',()=>run({action:mutedUsers.includes(m.name)?'unmute':'mute',username:m.name})));}}
   meta.append(controls);row.append(meta);const body=document.createElement('div');body.className='chat-content';renderRichChatBody(body,m.recalled?translateText('已撤回',language()):m.text,auth.token);row.append(body);if(!m.recalled)attachChatFold(row,body,scope+':'+m.id);
   const reactions=document.createElement('div');reactions.className='chat-reactions';for(const [emoji,users]of Object.entries(m.reactions||{})){if(!users.length)continue;const b=button(emoji+' '+users.length,()=>run({action:'react',id:m.id,emoji}));b.title=users.join(', ');b.setAttribute('aria-pressed',String(users.includes(auth.username)));reactions.append(b);}if(!m.recalled){const add=document.createElement('button');add.type='button';add.className='reaction-add';add.textContent='☺+';add.title='添加表情';add.onclick=()=>openEmojiPicker(add,emoji=>run({action:'react',id:m.id,emoji}));reactions.append(add);}row.append(reactions);rows.push(row);
   if(!initial&&!seen.has(m.id)&&m.name!==auth.username&&m.text?.includes('@'+auth.username)&&localStorage.getItem('junqi-mention-notifications')==='1'&&'Notification'in window&&Notification.permission==='granted')try{const n=new Notification(translateText('四国军棋：有人 @ 你',language()),{body:m.name+': '+m.text,tag:scope+':'+m.id});n.onclick=()=>{window.focus();input.focus();n.close();};}catch{}
   seen.add(m.id);
  }
  for(const row of old.values())releaseChatFolds(row);list.replaceChildren(...rows);renderMutedUsers(muted,moderator?mutedUsers:[],username=>run({action:'unmute',username}));
  list.scrollTop=initial||(nearBottom&&messages.some(m=>!knownIds.has(m.id)))?list.scrollHeight:oldTop;initial=false;
 }
 form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('button');b.disabled=true;try{const value=await composeImages(input,scope,auth.token);if(!value)return;await send(value);input.value='';clearImages(input);}catch(error){onError(error);}finally{b.disabled=false;}};
 input.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();form.requestSubmit();}};
 return {update,destroy:()=>{window.removeEventListener('junqi-language',syncMention);closeEmojiPicker();host.classList.remove('chat-expanded');releaseChatFolds(list);clearImages(input);host.replaceChildren();}};
}
