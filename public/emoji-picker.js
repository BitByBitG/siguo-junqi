import {emojiGroups,emojis} from './emojis.js';
let emojiPicker=null;
export function closeEmojiPicker(){emojiPicker?.remove();emojiPicker=null;}
export function openEmojiPicker(anchor,emit){
  closeEmojiPicker();
  const panel=document.createElement('div');panel.className='emoji-picker';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','选择表情');
  emojiPicker=panel;
  let recent=[];try{recent=JSON.parse(localStorage.getItem('junqi-recent-emojis')||'[]').filter(e=>emojis.includes(e)).slice(0,24);}catch{}
  const tabs=document.createElement('div');tabs.className='emoji-tabs',grid=document.createElement('div');grid.className='emoji-grid';
  const groups={'最近':recent,...Object.fromEntries(Object.entries(emojiGroups).map(([k,v])=>[k,v.split(' ')]))};
  const choose=key=>{
    grid.replaceChildren();for(const button of tabs.children)button.setAttribute('aria-pressed',String(button.textContent===key));
    if(!groups[key].length){const hint=document.createElement('span');hint.className='emoji-empty';hint.textContent='使用过的表情会显示在这里';grid.append(hint);}
    for(const emoji of groups[key]){
      const button=document.createElement('button');button.type='button';button.textContent=emoji;button.title=emoji;button.setAttribute('aria-label',emoji);
      button.onclick=()=>{try{localStorage.setItem('junqi-recent-emojis',JSON.stringify([emoji,...recent.filter(e=>e!==emoji)].slice(0,24)));}catch{}emit(emoji);closeEmojiPicker();if(anchor.isConnected)anchor.focus({preventScroll:true});};grid.append(button);
    }
  };
  for(const key of Object.keys(groups)){const button=document.createElement('button');button.type='button';button.textContent=key;button.onclick=()=>choose(key);tabs.append(button);}
  panel.append(tabs,grid);document.body.append(panel);choose(recent.length?'最近':'表情');
  const rect=anchor.getBoundingClientRect();panel.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-panel.offsetWidth-8))+'px';panel.style.top=Math.max(8,Math.min(rect.bottom+5,window.innerHeight-panel.offsetHeight-8))+'px';tabs.querySelector('button').focus();
}
document.addEventListener('pointerdown',event=>{if(emojiPicker&&!emojiPicker.contains(event.target)&&!event.target.closest('.reaction-add'))closeEmojiPicker();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeEmojiPicker();});
window.addEventListener('resize',closeEmojiPicker);
