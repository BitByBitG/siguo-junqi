import {io as plainIO} from 'socket.io-client';
import {dispatchSecureEvent} from '../public/secure-events.js';
import {createSecureClient} from '../bots/secure-client.js';
const clients=new Map();
export async function fetch(url,options={}){
  const base=new URL(url).origin;if(!new URL(url).pathname.startsWith('/api/'))return globalThis.fetch(url,options);
  let client=clients.get(base);if(!client){client=createSecureClient(base);clients.set(base,client);}
  try{return await client.fetch(url,options);}catch(error){
    if(!error.message.includes('加密连接失效'))throw error;
    client=createSecureClient(base);clients.set(base,client);return client.fetch(url,options);
  }
}
export function io(url,options={}){
  const client=createSecureClient(url),socket=plainIO(url,{...options,autoConnect:false,auth:async done=>done({id:(await client.channel()).id,proof:await client.seal({kind:'socket'})})});
  const emit=socket.emit.bind(socket);let incoming=Promise.resolve(),outgoing=Promise.resolve();
  socket.on('sealed',packet=>{const connectionId=socket.id;incoming=incoming.then(async()=>{const value=await client.open(packet);dispatchSecureEvent(socket,value,connectionId);});});
  socket.emit=(event,...args)=>{
    const ack=typeof args.at(-1)==='function'?args.pop():null,flags={...socket.flags};socket.flags={};
    outgoing=outgoing.then(async()=>{const packet=await client.seal({kind:'event',event,args});socket.flags=flags;
      if(ack)emit('sealed',packet,(...values)=>{if(flags.timeout!==undefined){if(values[0])return ack(values[0]);client.open(values[1]).then(v=>ack(null,...v.args));}else client.open(values[0]).then(v=>ack(...v.args));});else emit('sealed',packet);
    });return socket;
  };
  socket.connect();return socket;
}
