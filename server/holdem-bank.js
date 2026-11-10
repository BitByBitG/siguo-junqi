import crypto from 'node:crypto';
export const beijingDay=time=>Math.floor((time+8*3600000)/86400000);
export function chipInteger(value,min=0,max=Number.MAX_SAFE_INTEGER){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw Error('筹码必须是范围内的非负整数');return value;}
export function dailyAmount(from,to,rates){let total=0;for(let i=0;i<rates.length;i++){const a=Math.max(from,rates[i].fromDay),b=Math.min(to,(rates[i+1]?.fromDay??Infinity)-1);if(a<=b)total=chipInteger(total+(b-a+1)*rates[i].amount);}return total;}
export class ChipBank{
 constructor(accounts,state,assets=()=>0,now=()=>Date.now()){this.accounts=accounts;this.assets=assets;this.now=now;this.restore(state||{config:{initial:10000,daily:2000},rates:[{fromDay:0,amount:2000}],wallets:{},audit:[],requests:{}});}
 restore(s){this.config=s.config;this.rates=s.rates;this.wallets=Object.assign(Object.create(null),s.wallets);this.audit=s.audit||[];this.requests=Object.assign(Object.create(null),s.requests||{});this.validate();}
 state(){return {config:this.config,rates:this.rates,wallets:this.wallets,audit:this.audit,requests:this.requests};}
 eligible(n){const a=this.accounts[n];return !!a&&a.type!=='bot'&&a.status!=='pending'&&!a.blocked&&a.holdemEnabled===true;}
 record(kind,operator,recipients,amount,extra={}){this.audit.push({id:crypto.randomUUID(),kind,operator,recipients,amount,time:this.now(),...extra});if(this.audit.length>10000)this.audit.splice(0,this.audit.length-10000);}
 sync(n){const day=beijingDay(this.now());let w=Object.hasOwn(this.wallets,n)?this.wallets[n]:null;if(!w){if(!this.eligible(n))return;const balance=Math.max(0,this.config.initial-this.assets(n));w=this.wallets[n]={balance,lastGrantDay:day,initializedAt:this.now()};this.record('initial','system',[n],balance);return;}
  if(w.lastGrantDay>=day)return;if(this.eligible(n)){const amount=dailyAmount(w.lastGrantDay+1,day,this.rates);if(amount){this.credit(n,amount);this.record('daily','system',[n],amount,{fromDay:w.lastGrantDay+1,toDay:day});}}w.lastGrantDay=day;
 }
 syncAll(){for(const n of new Set([...Object.keys(this.accounts),...Object.keys(this.wallets)]))this.sync(n);}
 ensure(n){this.sync(n);const w=this.wallets[n];if(!w)throw Error('德州扑克权限未开通或已停用');return w;}
 debit(n,amount){chipInteger(amount,1);const w=this.ensure(n);if(w.balance<amount)throw Error('筹码余额不足，禁止借贷或透支');w.balance-=amount;}
 credit(n,amount){chipInteger(amount);const w=this.wallets[n];if(!w)throw Error('筹码账户不存在');w.balance=chipInteger(w.balance+amount);}
 configure(initial,daily,operator){chipInteger(initial,0,1000000000);chipInteger(daily,0,1000000000);this.syncAll();this.config={initial,daily};const fromDay=beijingDay(this.now())+1;this.rates=this.rates.filter(r=>r.fromDay<fromDay);this.rates.push({fromDay,amount:daily});this.record('settings',operator,[],0,{initial,daily});}
 grant(names,amount,operator,requestId){chipInteger(amount,1,1000000000);if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{6,80}$/.test(requestId))throw Error('无效的发放请求编号');
  const signature=JSON.stringify({names:[...names].sort(),amount,operator});if(Object.hasOwn(this.requests,requestId)){if(this.requests[requestId]!==signature)throw Error('发放请求编号已用于其他操作');return;}
  for(const n of names){if(!this.accounts[n]||this.accounts[n].type==='bot'||this.accounts[n].status==='pending')throw Error('账号不存在或不是玩家账号');if(!this.wallets[n])throw Error('请先开通德州扑克权限');chipInteger(this.wallets[n].balance+amount);}
  for(const n of names)this.credit(n,amount);this.record('admin-grant',operator,names,amount);this.requests[requestId]=signature;const keys=Object.keys(this.requests);if(keys.length>10000)delete this.requests[keys[0]];
 }
 validate(){chipInteger(this.config.initial,0,1000000000);chipInteger(this.config.daily,0,1000000000);if(!Array.isArray(this.rates)||!this.rates.length)throw Error('每日筹码配置无效');let previous=-1;for(const r of this.rates){chipInteger(r.fromDay);chipInteger(r.amount,0,1000000000);if(r.fromDay<=previous)throw Error('每日筹码配置无效');previous=r.fromDay;}for(const w of Object.values(this.wallets)){chipInteger(w.balance);chipInteger(w.lastGrantDay);}}
}
