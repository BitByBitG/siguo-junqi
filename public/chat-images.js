import {b64,bytes} from './secure.js';
const drafts=new WeakMap();
const imageCache=new Map();
const IMAGE_CACHE_LIMIT=64*1024*1024;
let imageCacheBytes=0;
function touchCache(key,entry){imageCache.delete(key);imageCache.set(key,entry);}
function trimCache(){
  while(imageCacheBytes>IMAGE_CACHE_LIMIT&&imageCache.size>1){
    const [key,entry]=imageCache.entries().next().value;
    if(entry.promise){imageCache.delete(key);continue;}
    imageCache.delete(key);imageCacheBytes-=entry.size||0;
  }
}
async function loadImage(url,headers){
  let entry=imageCache.get(url.pathname);
  if(entry){touchCache(url.pathname,entry);return entry.promise||entry;}
  entry={promise:(async()=>{
    const response=await fetch(url.pathname,{headers}),data=await response.json();
    if(!response.ok)throw Error(data.error);
    if(!['image/png','image/jpeg','image/gif','image/webp'].includes(data.type))throw Error('图片格式错误');
    const raw=bytes(data.data),ready={blob:new Blob([raw],{type:data.type}),size:raw.byteLength};
    imageCacheBytes+=ready.size;imageCache.set(url.pathname,ready);trimCache();return ready;
  })()};
  imageCache.set(url.pathname,entry);
  try{return await entry.promise;}catch(error){if(imageCache.get(url.pathname)===entry)imageCache.delete(url.pathname);throw error;}
}
export function attachImages(input){
  const items=[],preview=document.createElement('div');preview.className='image-drafts';input.after(preview);drafts.set(input,items);
  input.addEventListener('paste',event=>{
    const files=[...event.clipboardData.items].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile());
    if(!files.length)return;event.preventDefault();
    for(const file of files){
      if(file.size>8*1024*1024||items.length>=4){alert('每次最多 4 张图片，每张最大 8 MiB');continue;}
      const item={file,blob:URL.createObjectURL(file)},row=document.createElement('span'),image=document.createElement('img'),remove=document.createElement('button');
      item.row=row;image.src=item.blob;image.alt=file.name;remove.type='button';remove.textContent='移除';
      remove.onclick=()=>{items.splice(items.indexOf(item),1);URL.revokeObjectURL(item.blob);row.remove();};row.append(image,remove);preview.append(row);items.push(item);
    }
  });
}
export async function composeImages(input,scope,token){
  const items=drafts.get(input)||[],links=[];
  for(const item of items){
    if(!item.url){
      const response=await fetch('/api/images',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({scope,data:b64(new Uint8Array(await item.file.arrayBuffer()))})});
      const result=await response.json();if(!response.ok)throw Error(result.error);item.url=result.url;
    }
    links.push(`![](${location.origin}${item.url})`);
  }
  const text=[input.value.trim(),...links].filter(Boolean).join('\n');
  if(text.length>8000)throw Error('文字和图片引用合计不能超过 8000 字符');
  return text;
}
export function clearImages(input){const items=drafts.get(input)||[];for(const item of items){URL.revokeObjectURL(item.blob);item.row.remove();}items.splice(0);}
export async function displayImage(image,headers){
  const source=image.dataset.imageUrl||image.getAttribute('src');let url;
  try{url=new URL(source,location.origin);}catch{return false;}
  if(url.origin!==location.origin||!/^\/api\/images\/[0-9a-f-]{36}$/.test(url.pathname))return false;
  image.removeAttribute('src');
  if(!imageCache.has(url.pathname))image.alt='图片加载中…';
  try{
    const cached=await loadImage(url,headers),blob=URL.createObjectURL(cached.blob);
    image.onload=image.onerror=()=>URL.revokeObjectURL(blob);image.src=blob;image.alt='聊天图片';
  }catch(error){image.alt=error.message;}
  return true;
}
