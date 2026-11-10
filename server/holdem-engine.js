import { randomInt } from 'node:crypto';
export const STAGES=['preflop','flop','turn','river'];
export const LABELS=['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺'];
export function deck(){const a=Array.from({length:52},(_,i)=>i);for(let i=51;i;i--){const j=randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
export function compare(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]??0)!==(b[i]??0))return (a[i]??0)-(b[i]??0);}return 0;}
function five(a){
 const ranks=a.map(x=>x%13+2).sort((a,b)=>b-a),flush=a.every(x=>Math.floor(x/13)===Math.floor(a[0]/13));
 const u=[...new Set(ranks)];if(u[0]===14)u.push(1);let straight=0;
 for(let i=0;i+4<u.length;i++)if(u[i]-u[i+4]===4){straight=u[i];break;}
 const g=[...new Set(ranks)].map(r=>[ranks.filter(x=>x===r).length,r]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]);
 if(flush&&straight)return [8,straight];
 if(g[0][0]===4)return [7,g[0][1],g[1][1]];
 if(g[0][0]===3&&g[1][0]===2)return [6,g[0][1],g[1][1]];
 if(flush)return [5,...ranks];if(straight)return [4,straight];
 if(g[0][0]===3)return [3,...g.map(x=>x[1])];
 if(g[0][0]===2&&g[1][0]===2)return [2,...g.map(x=>x[1])];
 if(g[0][0]===2)return [1,...g.map(x=>x[1])];return [0,...ranks];
}
export function evaluate(a){let best=[];for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)for(let k=j+1;k<a.length;k++)for(let l=k+1;l<a.length;l++)for(let m=l+1;m<a.length;m++){const v=five([a[i],a[j],a[k],a[l],a[m]]);if(compare(v,best)>0)best=v;}return best;}
export class Table {
 constructor({max=6,stack=2000,sb=10,time=30}={}){this.max=max;this.stack=stack;this.sb=sb;this.bb=sb*2;this.time=time;this.players=Array(max).fill(null);this.button=-1;this.hand=0;this.phase='waiting';this.board=[];this.logs=[];this.results=[];this.turn=-1;this.deadline=0;this.version=0;}
 log(s){this.logs.push(s);this.logs=this.logs.slice(-100);}
 active(){return this.players.map((p,i)=>p&&!p.folded&&p.inHand?i:-1).filter(i=>i>=0);}
 next(i,pred){for(let k=1;k<=this.max;k++){const j=(i+k+this.max)%this.max;if(this.players[j]&&pred(this.players[j],j))return j;}return -1;}
 seat(id,name,index,chips=this.stack){if(this.players.some(p=>p?.id===id))throw Error('你已落座');if(!Number.isSafeInteger(chips)||chips<=0)throw Error('筹码余额不足');if(!Number.isInteger(index)||index<0||index>=this.max||this.players[index])throw Error('座位不可用');this.players[index]={id,name,chips,ready:false,inHand:false,connected:true};this.version++;}
 cashout(i){const p=this.players[i];if(!p)return;this.cashouts||=[];this.cashouts.push({id:p.id,amount:p.chips});this.players[i]=null;}
 takeCashouts(){return (this.cashouts||[]).splice(0);}
 leave(id){const i=this.players.findIndex(p=>p?.id===id);if(i<0)return;const p=this.players[i];if(p.inHand&&this.phase!=='finished'&&this.phase!=='waiting'){p.leaving=true;p.folded=true;p.ready=false;this.log(`${p.name} 离座并弃牌`);if(this.active().length<=1)this.finish();else if(this.turn===i){this.turn=this.next(i,(q,j)=>this.needs(q,j));this.advance();}}else this.cashout(i);this.version++;}
 start(){if(!['waiting','finished'].includes(this.phase))throw Error('本手尚未结束');
 for(let i=0;i<this.max;i++)if(this.players[i]?.leaving)this.cashout(i);
 const ps=this.players.filter(p=>p?.ready&&(!this.funded||p.chips>0));if(ps.length<2)throw Error('至少需要两名玩家准备');
 this.chipChanges=[];this.revealedHands=[];this.hand++;this.phase='preflop';this.board=[];this.results=[];this.cards=deck();this.current=this.bb;this.raiseSize=this.bb;this.deadline=0;
 for(const p of this.players)if(p){p.inHand=p.ready&&(!this.funded||p.chips>0);p.folded=!p.inHand;p.bet=0;p.total=0;p.actedAt=null;p.last='';p.hole=[];if(p.inHand){if(!p.chips&&!this.funded)p.chips=this.stack;p.handStartChips=p.chips;p.hole=[this.cards.pop(),this.cards.pop()];}}
 this.button=this.next(this.button,p=>p.inHand);const s=ps.length===2?this.button:this.next(this.button,p=>p.inHand),b=this.next(s,p=>p.inHand);
 this.pay(s,this.sb);this.players[s].last='小盲';this.pay(b,this.bb);this.players[b].last='大盲';this.turn=this.next(b,(p,i)=>this.needs(p,i));this.log(`第 ${this.hand} 手开始 · 盲注 ${this.sb}/${this.bb}`);this.advance();this.version++;
 }
 pay(i,n){const p=this.players[i];n=Math.min(n,p.chips);p.chips-=n;p.bet+=n;p.total+=n;}
 needs(p){return p.inHand&&!p.folded&&p.chips>0&&(p.actedAt===null||p.bet<this.current);}
 canRaise(p){return p.actedAt===null||this.current-p.actedAt>=this.raiseSize;}
 action(id,type,amount){const p=this.players[this.turn];if(!p||p.id!==id||!STAGES.includes(this.phase))throw Error('还没有轮到你');
 const call=Math.max(0,this.current-p.bet);let message;
 if(type==='fold'){p.folded=true;message='弃牌';}
 else if(type==='check'){if(call)throw Error('当前不能过牌');message='过牌';}
 else if(type==='call'){if(!call)throw Error('无需跟注');this.pay(this.turn,call);message=p.chips?'跟注':'全下';}
 else if(type==='raise'||type==='allin'){
 const target=type==='allin'?p.bet+p.chips:Number(amount);if(!Number.isSafeInteger(target)||target<=p.bet||target>p.bet+p.chips)throw Error('下注金额无效');
 if(target>this.current){if(!this.canRaise(p))throw Error('短码全下未重新开放你的加注权');if(this.active().filter(i=>this.players[i].chips>0).length<2)throw Error('没有可以响应加注的玩家');
 const inc=target-this.current;if(inc<this.raiseSize&&target!==p.bet+p.chips)throw Error(`最小加注到 ${this.current+this.raiseSize}`);if(inc>=this.raiseSize)this.raiseSize=inc;this.current=target;}
 else if(type!=='allin')throw Error('加注必须超过当前下注');
 this.pay(this.turn,target-p.bet);message=p.chips?`加注到 ${target}`:'全下';
 }else throw Error('未知操作');
 p.last=message;p.actedAt=this.current;this.log(`${p.name} ${message}`);const old=this.turn;this.turn=this.next(old,(q,i)=>this.needs(q,i));this.advance();this.version++;
 }
 advance(){
 if(this.active().length<=1)return this.finish();
 // With only one player retaining chips, only an outstanding call needs a decision.
 const capable=this.active().filter(i=>this.players[i].chips>0);
 if(capable.length<=1){const i=capable[0];if(i!==undefined&&this.players[i].bet<this.current){this.turn=i;this.deadline=Date.now()+this.time*1000;return;}this.runout();return this.finish();}
 if(this.turn<0){
 if(this.phase==='river')return this.finish();
 this.street();this.turn=this.next(this.button,(p,i)=>this.needs(p,i));
 }
 this.deadline=Date.now()+this.time*1000;
 }
 street(){this.phase=STAGES[STAGES.indexOf(this.phase)+1];this.cards.pop();for(let n=this.phase==='flop'?3:1;n;n--)this.board.push(this.cards.pop());this.current=0;this.raiseSize=this.bb;for(const p of this.players)if(p){p.bet=0;p.actedAt=null;p.last='';}this.log(({flop:'翻牌',turn:'转牌',river:'河牌'})[this.phase]);}
 runout(){while(this.phase!=='river')this.street();}
 revealHands(){this.revealedHands=this.players.filter(p=>p?.inHand&&p.hole?.length).map(p=>({id:p.id,name:p.name,hole:[...p.hole]}));}
 finish(){
 this.revealHands();
 const alive=this.active();this.results=[];this.showdown=alive.length>1;const levels=[...new Set(this.players.filter(p=>p?.total>0).map(p=>p.total))].sort((a,b)=>a-b);let prev=0;
 const scores=new Map(alive.map(i=>[i,this.showdown?evaluate([...this.players[i].hole,...this.board]):[0]]));
 for(const level of levels){const contributors=this.players.map((p,i)=>p?.total>=level?i:-1).filter(i=>i>=0);const amount=(level-prev)*contributors.length;prev=level;
 if(contributors.length===1){const p=this.players[contributors[0]];p.chips+=amount;this.results.push({name:p.name,amount,label:'未跟注退回'});continue;}
 const eligible=alive.length===1?alive:alive.filter(i=>this.players[i].total>=level);if(!eligible.length)throw Error('底池无合格玩家');let best=[];for(const i of eligible)if(compare(scores.get(i),best)>0)best=scores.get(i);const winners=eligible.filter(i=>compare(scores.get(i),best)===0).sort((a,b)=>(a-this.button-1+this.max)%this.max-(b-this.button-1+this.max)%this.max);
 winners.forEach((i,k)=>{const n=Math.floor(amount/winners.length)+(k<amount%winners.length?1:0);this.players[i].chips+=n;this.results.push({name:this.players[i].name,amount:n,label:this.showdown?LABELS[scores.get(i)[0]]:'其他玩家弃牌'});});
 }
 this.chipChanges=this.players.filter(p=>p?.inHand).map(p=>({id:p.id,before:p.handStartChips??p.chips,after:p.chips,delta:p.chips-(p.handStartChips??p.chips)}));for(const r of this.results)this.log(`${r.name} +${r.amount}（${r.label}）`);this.phase='finished';this.turn=-1;this.deadline=0;for(let i=0;i<this.max;i++)if(this.players[i]){this.players[i].ready=false;if(this.players[i].leaving)this.cashout(i);}
 }
 view(id){const me=this.players.find(p=>p?.id===id),acting=this.players[this.turn];return {max:this.max,stack:this.stack,sb:this.sb,bb:this.bb,time:this.time,phase:this.phase,hand:this.hand,button:this.button,board:this.board,turn:this.turn,deadline:this.deadline,current:this.current||0,raiseSize:this.raiseSize||this.bb,pot:this.phase==='finished'?0:this.players.reduce((a,p)=>a+(p?.total||0),0),results:this.results,chipChanges:this.phase==='finished'?(this.chipChanges||[]):[],revealedHands:this.phase==='finished'?(this.revealedHands||[]):[],logs:this.logs,players:this.players.map(p=>p?{id:p.id,name:p.name,chips:p.chips,ready:p.ready,inHand:p.inHand,folded:p.folded,bet:p.bet||0,total:p.total||0,last:p.last,connected:p.connected,leaving:p.leaving,hole:p.id===id||(this.phase==='finished'&&p.inHand)?p.hole||[]:(p.hole||[]).map(()=>null)}:null),legal:acting?.id===id?{call:Math.min(me.chips,Math.max(0,this.current-me.bet)),min:this.current+this.raiseSize,max:me.bet+me.chips,canRaise:this.canRaise(me)&&this.active().filter(i=>this.players[i].chips>0).length>=2}:null};}
}
