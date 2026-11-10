// Minimal external Hold’em client: check when possible, otherwise call.
// Required environment: BOT_SERVER, BOT_USERNAME, BOT_PASSWORD, BOT_ROOM.
import {setTimeout as sleep} from 'node:timers/promises';
import {createSecureClient} from './secure-client.js';

const {BOT_SERVER,BOT_USERNAME,BOT_PASSWORD,BOT_ROOM}=process.env;
if(!BOT_SERVER||!BOT_USERNAME||!BOT_PASSWORD||!BOT_ROOM){
 console.error('Set BOT_SERVER, BOT_USERNAME, BOT_PASSWORD and BOT_ROOM.');
 process.exit(1);
}
const client=createSecureClient(BOT_SERVER.replace(/\/$/,''));
let token;
async function request(route,body){
 const response=await client.fetch(route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const data=await response.json();
 if(!response.ok)throw Object.assign(Error(data.error||`HTTP ${response.status}`),{status:response.status});
 return data;
}
async function login(){token=(await request('/api/bot/login',{username:BOT_USERNAME,password:BOT_PASSWORD})).token;}
const room='/api/bot/holdem/rooms/'+encodeURIComponent(BOT_ROOM),action=body=>request(room+'/action',body);
await login();
let joined=false;
while(true){
 try{
  const state=await request(joined?room:room+'/join',joined?undefined:{});joined=true;
  const me=state.players.find(p=>p?.id===state.viewerName);
  if(!me){
   const index=state.players.findIndex(p=>p===null),buyIn=Math.min(state.stack,state.wallet.balance);
   if(index>=0&&buyIn>=state.bb*10)await action({op:'seat',index,buyIn});
  }else if(['waiting','finished'].includes(state.phase)){
   if(!me.chips)await action({op:'stand'});
   else if(!me.ready)await action({op:'ready',ready:true});
   else if(process.env.BOT_AUTO_START==='true'&&state.owner===state.viewerName&&state.players.filter(p=>p?.ready&&p.chips>0).length>=2)await action({op:'start'});
  }else if(state.legal){
   await action({op:'bet',type:state.legal.call?'call':'check',hand:state.hand,turn:state.turn,version:state.version});
  }
 }catch(error){
  if(error.status===401){await login();joined=false;}
  else if(error.status===403||error.status===404){console.error(error.message);process.exitCode=1;break;}
  else if(error.status!==409)console.error(error.message);
 }
 await sleep(1000);
}
