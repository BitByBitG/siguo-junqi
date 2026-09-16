import { webcrypto } from 'node:crypto';
export function createSecureClient(baseUrl){
  const nativeFetch=globalThis.fetch,subtle=webcrypto.subtle;
  let pending;
  const channel=()=>pending||=(async()=>{
    const pair=await subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
    const response=await nativeFetch(baseUrl+'/api/crypto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publicKey:await subtle.exportKey('jwk',pair.publicKey)})});
    const data=await response.json();if(!response.ok)throw Error(data.error);
    const raw=await subtle.decrypt('RSA-OAEP',pair.privateKey,Buffer.from(data.key,'base64'));
    return {id:data.id,key:await subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])};
  })();
  const seal=async value=>{
    const c=await channel(),iv=webcrypto.getRandomValues(new Uint8Array(12));
    const data=await subtle.encrypt({name:'AES-GCM',iv,additionalData:Buffer.from('client-v1')},c.key,Buffer.from(JSON.stringify({...value,time:Date.now(),nonce:webcrypto.randomUUID()})));
    return {id:c.id,iv:Buffer.from(iv).toString('base64'),data:Buffer.from(data).toString('base64')};
  };
  const seen=new Map();
  const open=async packet=>{
    const c=await channel();const data=JSON.parse(Buffer.from(await subtle.decrypt({name:'AES-GCM',iv:Buffer.from(packet.iv,'base64'),additionalData:Buffer.from('server-v1')},c.key,Buffer.from(packet.data,'base64'))));
    if(Math.abs(Date.now()-data.time)>120000||seen.has(data.nonce))throw Error('响应过期或重复');
    for(const [nonce,time]of seen)if(Date.now()-time>120000)seen.delete(nonce);
    seen.set(data.nonce,Date.now());return data.value;
  };
  const request=async(url,options={})=>{
    const target=new URL(url,baseUrl),headers=new Headers(options.headers);
    const packet=await seal({kind:'http',url:target.pathname+target.search,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined,authorization:headers.get('Authorization'),adminKey:headers.get('x-admin-key')});
    const response=await nativeFetch(baseUrl+'/api/secure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(packet),signal:options.signal});
    const data=await response.json();if(!data.iv){pending=undefined;throw Error(data.error||'加密连接失效');}
    return new Response(JSON.stringify(await open(data)),{status:response.status,headers:{'Content-Type':'application/json'}});
  };
  return {fetch:request,seal,open,channel};
}
