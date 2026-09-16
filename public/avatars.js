import '/secure.js';
const cache=new Map();
let size=0;
export function avatarImage(username,version){
  const img=document.createElement('img');img.src='/favicon.png?v=240';img.alt=username+' 的头像';img.className='user-avatar';img.width=36;img.height=36;img.loading='lazy';img.decoding='async';
  if(version===null)return img;
  const key=username+':'+(version||'unknown');
  if(!cache.has(key)){
    const promise=fetch('/api/avatar/'+encodeURIComponent(username)).then(async r=>{
      if(!r.ok)return null;const data=await r.json();if(!['image/png','image/jpeg','image/webp','image/gif'].includes(data.type))return null;
      const url=`data:${data.type};base64,${data.data}`;
      const entry=cache.get(key);if(entry){entry.size=url.length;size+=url.length;}
      while((size>24*1024*1024||cache.size>64)&&cache.size){const [old,entry]=cache.entries().next().value;cache.delete(old);size-=entry.size||0;}
      return url;
    }).catch(()=>{cache.delete(key);return null;});
    cache.set(key,{promise,size:0});
  }
  cache.get(key)?.promise.then(url=>{if(url)img.src=url;});
  return img;
}
export function messageTime(value){
  if(value===undefined||value===null||value==='')return null;
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return null;
  const time=document.createElement('time');time.dateTime=date.toISOString();time.className='chat-time';time.textContent=date.toLocaleString();return time;
}
