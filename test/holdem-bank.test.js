import test from 'node:test';
import assert from 'node:assert/strict';
import {ChipBank,beijingDay,dailyAmount} from '../server/holdem-bank.js';
const account=()=>({type:'human',holdemEnabled:true});
test('Beijing midnight, offline catch-up, no duplicate initial/daily grant',()=>{
 let now=Date.parse('2026-10-15T15:59:59Z');const accounts={A:account()},b=new ChipBank(accounts,null,()=>0,()=>now);b.syncAll();assert.equal(b.wallets.A.balance,10000);
 now+=1000;b.syncAll();assert.equal(b.wallets.A.balance,12000);b.syncAll();assert.equal(b.wallets.A.balance,12000);
 now+=3*86400000;b.syncAll();assert.equal(b.wallets.A.balance,18000);const loaded=new ChipBank(accounts,JSON.parse(JSON.stringify(b.state())),()=>0,()=>now);loaded.syncAll();assert.equal(loaded.wallets.A.balance,18000);assert.equal(beijingDay(now),beijingDay(now-1)+1);
});
test('new settings apply to future activation and next midnight, not retroactively',()=>{
 let now=Date.parse('2026-10-15T03:00:00Z');const accounts={A:account()},b=new ChipBank(accounts,null,()=>0,()=>now);b.syncAll();b.configure(5000,3000,'admin');accounts.B=account();b.syncAll();assert.equal(b.wallets.A.balance,10000);assert.equal(b.wallets.B.balance,5000);now+=2*86400000;b.syncAll();assert.equal(b.wallets.A.balance,16000);assert.equal(b.wallets.B.balance,11000);
 assert.equal(dailyAmount(1,4,[{fromDay:0,amount:2},{fromDay:3,amount:3}]),10);
});
test('disabled/blocked/bot accounts get no daily grant and toggling cannot repeat initial grant',()=>{
 let now=Date.parse('2026-10-15T03:00:00Z');const accounts={A:account(),Bot:{type:'bot',holdemEnabled:true}},b=new ChipBank(accounts,null,()=>0,()=>now);b.syncAll();assert(!b.wallets.Bot);accounts.A.holdemEnabled=false;now+=3*86400000;b.syncAll();accounts.A.holdemEnabled=true;b.syncAll();assert.equal(b.wallets.A.balance,10000);accounts.A.blocked=true;now+=86400000;b.syncAll();accounts.A.blocked=false;b.syncAll();assert.equal(b.wallets.A.balance,10000);
});
test('no debt, malformed values or duplicate admin grants; legacy table chips counted once',()=>{
 const accounts={A:account(),B:account()},b=new ChipBank(accounts,null,n=>n==='A'?2000:0);b.syncAll();assert.equal(b.wallets.A.balance,8000);assert.throws(()=>b.debit('A',9000));assert.equal(b.wallets.A.balance,8000);
 for(const amount of [-1,.5,NaN,Infinity,'2'])assert.throws(()=>b.credit('A',amount));
 b.grant(['A','B'],200,'admin','request-123');b.grant(['A','B'],200,'admin','request-123');assert.equal(b.wallets.A.balance,8200);assert.equal(b.wallets.B.balance,10200);assert.throws(()=>b.grant(['A'],300,'admin','request-123'));assert.throws(()=>b.grant(['A','Missing'],100,'admin','request-456'));assert.equal(b.wallets.A.balance,8200);
});
