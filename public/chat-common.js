
import {displayImage} from './chat-images.js';

export function renderRichChatBody(body,text,token){
  const template=document.createElement('template');
  if(window.marked&&window.DOMPurify)template.innerHTML=DOMPurify.sanitize(marked.parse(String(text||''),{breaks:true}),{
    USE_PROFILES:{html:true},
    FORBID_TAGS:['style','form','input','button','iframe','video','audio','source','track','picture'],
    FORBID_ATTR:['style','id','name','srcset']
  });
  else template.content.textContent=String(text||'');
  for(const img of template.content.querySelectorAll('img')){
    const src=img.getAttribute('src')||'';img.removeAttribute('src');
    try{
      const url=new URL(src,location.origin);
      if(url.origin===location.origin&&/^\/api\/images\/[0-9a-f-]{36}$/.test(url.pathname)){img.dataset.imageUrl=url.pathname;continue;}
      if(/^https?:$/.test(url.protocol)){img.src=url.href;img.loading='lazy';img.referrerPolicy='no-referrer';img.decoding='async';}
      else img.remove();
    }catch{img.remove();}
  }
  body.append(template.content);
  for(const img of body.querySelectorAll('img[data-image-url]'))displayImage(img,typeof token==='object'?token:{Authorization:`Bearer ${token||''}`});
  for(const link of body.querySelectorAll('a')){link.target='_blank';link.rel='noopener noreferrer';}
  if(window.renderMathInElement)renderMathInElement(body,{delimiters:[
    {left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}
  ],throwOnError:false,trust:false,maxExpand:1000,maxSize:20});
}

const expandedMessages = new Set();
const foldMeasures = new WeakMap();
const foldObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
  for(const {target} of entries) foldMeasures.get(target)?.();
}) : null;

export function releaseChatFolds(list){list.querySelectorAll('.foldable-message').forEach(body=>foldObserver?.unobserve(body));}
export function attachChatFold(row,body,messageKey){
 body.classList.add('foldable-message');body.classList.toggle('message-expanded',expandedMessages.has(messageKey));
 const toggle=document.createElement('button');toggle.type='button';toggle.className='message-toggle';toggle.hidden=true;
 const sync=()=>{const expanded=expandedMessages.has(messageKey);toggle.textContent=expanded?'收起':'展开全文';toggle.setAttribute('aria-expanded',String(expanded));};sync();
 toggle.onclick=()=>{const expanded=!body.classList.contains('message-expanded');body.classList.toggle('message-expanded',expanded);if(expanded)expandedMessages.add(messageKey);else expandedMessages.delete(messageKey);sync();};
 const measure=()=>{toggle.hidden=body.scrollHeight<=parseFloat(getComputedStyle(body).lineHeight)*10+1;};
 foldMeasures.set(body,measure);foldObserver?.observe(body);requestAnimationFrame(measure);body.addEventListener('load',measure,true);row.append(toggle);
}
