import {dispatchSecureEvent} from './secure-events.js';
const encoder=new TextEncoder(),decoder=new TextDecoder();
const b64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);};
const bytes=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const nativeFetch=window.fetch.bind(window);
let pending;
async function responseJson(response,source){const text=await response.text();try{return JSON.parse(text);}catch{const html=/^\s*</.test(text);throw Error(`${source}返回了${html?'网页':'无效数据'}（HTTP ${response.status}），请确认 Node 服务仍在运行并检查 Cloudflare Tunnel`);}}
async function channel(){
  if(!pending)pending=(async()=>{
    if(!crypto.subtle)throw Error('加密功能需要 HTTPS 或 localhost，请使用 HTTPS 域名访问');
    const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
    const response=await nativeFetch('/api/crypto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publicKey:await crypto.subtle.exportKey('jwk',pair.publicKey)})});
    const info=await responseJson(response,'加密连接接口');if(!response.ok)throw Error(info.error);
    const raw=await crypto.subtle.decrypt({name:'RSA-OAEP'},pair.privateKey,bytes(info.key));
    return {id:info.id,key:await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])};
  })().catch(error=>{pending=null;throw error;});
  return pending;
}
async function seal(value){
  const c=await channel(),iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('client-v1')},c.key,encoder.encode(JSON.stringify({...value,time:Date.now(),nonce:crypto.randomUUID()})));
  return {id:c.id,iv:b64(iv),data:b64(new Uint8Array(data))};
}
const received=new Map();
async function open(packet){
  const c=await channel(),message=JSON.parse(decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(packet.iv),additionalData:encoder.encode('server-v1')},c.key,bytes(packet.data))));
  if(Math.abs(Date.now()-message.time)>120000||received.has(message.nonce))throw Error('响应过期或重复');
  for(const [id,time]of received)if(Date.now()-time>120000)received.delete(id);
  received.set(message.nonce,Date.now());return message.value;
}
export async function secureFetch(url,options={},retry=true){
  const target=new URL(url,location.href);
  if(target.origin!==location.origin||!target.pathname.startsWith('/api/'))return nativeFetch(url,options);
  const headers=new Headers(options.headers),body=options.body?JSON.parse(options.body):undefined;
  const packet=await seal({kind:'http',url:target.pathname+target.search,method:options.method||'GET',body,authorization:headers.get('Authorization'),adminKey:headers.get('x-admin-key')});
  const response=await nativeFetch('/api/secure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(packet),signal:options.signal});
  const data=await responseJson(response,'加密请求接口');if(!data.iv){pending=null;if(retry&&response.status===400)return secureFetch(url,options,false);throw Error(data.error||'加密连接错误，请刷新');}
  return new Response(JSON.stringify(await open(data)),{status:response.status,headers:{'Content-Type':'application/json'}});
}
window.fetch=secureFetch;
export function secureSocket(){
  const socket=io({autoConnect:false,transports:['websocket','polling'],auth:async done=>{try{done({id:(await channel()).id,proof:await seal({kind:'socket'})});}catch(error){alert(error.message);}}});
  const emit=socket.emit.bind(socket);
  socket.on('connect_error',()=>{pending=null;setTimeout(()=>socket.connect(),1500);});
  let outbound=Promise.resolve(),inbound=Promise.resolve();
  socket.on('sealed',packet=>{const connectionId=socket.id;inbound=inbound.then(async()=>{const value=await open(packet);dispatchSecureEvent(socket,value,connectionId);}).catch(()=>socket.disconnect());});
  socket.emit=(event,...args)=>{
    const flags={...socket.flags};socket.flags={};
    const ack=typeof args.at(-1)==='function'?args.pop():null;
    outbound=outbound.then(async()=>{
      const packet=await seal({kind:'event',event,args});socket.flags=flags;
      if(ack)emit('sealed',packet,(...values)=>{
        if(flags.timeout!==undefined){const[error,value]=values;if(error)return ack(error);open(value).then(v=>ack(null,...v.args)).catch(ack);}
        else open(values[0]).then(v=>ack(...v.args));
      });else emit('sealed',packet);
    }).catch(error=>{if(ack)ack(error);else alert(error.message);});return socket;
  };
  channel().then(()=>socket.connect()).catch(error=>alert(error.message));return socket;
}
export {b64,bytes};
