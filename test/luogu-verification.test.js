import test from 'node:test';
import assert from 'node:assert/strict';
import {__test,installLuoguVerification} from '../server/luogu-verification.js';

test('洛谷剪贴板必须匹配随机串并读取作者 UID',()=>{
  assert.deepEqual(__test.parsePaste({currentData:{paste:{data:'JUNQI-abc',user:{uid:123}}}},'JUNQI-abc'),{uid:123});
  assert.throws(()=>__test.parsePaste({currentData:{paste:{data:'wrong',user:{uid:123}}}},'JUNQI-abc'));
});

test('洛谷用户分别识别钩子等级与竞赛气球',()=>{
  assert.deepEqual(__test.parseUser({currentData:{user:{uid:123,name:'Tester',ccfLevel:3,badge:'balloon'}}},123),{uid:123,name:'Tester',ccfLevel:3,balloon:true,blueHook:true});
  assert.deepEqual(__test.parseUser({currentData:{user:{uid:123,name:'Tester',ccfLevel:0,icpcLevel:1}}},123),{uid:123,name:'Tester',ccfLevel:0,balloon:true,blueHook:false});
  assert.equal(__test.parseUser({currentData:{user:{uid:123,name:'Tester',ccfLevel:0}}},123).balloon,false);
});

test('同一 UID 可各绑定一个玩家和 BOT，但同类型只有一个',()=>{
  const accounts={Alice:{type:'human',luogu:{uid:123}},Robot:{type:'bot',luogu:{uid:123}}};
  const api=installLuoguVerification({post(){}},{accounts,authorize:()=>null,saveAccounts:{flush:async()=>{}}});
  assert.equal(api.ownerOf(123,'human'),'Alice');
  assert.equal(api.ownerOf(123,'bot'),'Robot');
  assert.equal(api.ownerOf(456,'human'),null);
});

test('管理员可给已审核账号绑定 UID，并保留分类型唯一约束',async()=>{
  const accounts={Alice:{type:'human',status:'active'},Bob:{type:'human',status:'active',luogu:{uid:456}},Charlie:{type:'human',status:'active'}},app={post(){}};
  const original=globalThis.fetch;globalThis.fetch=async()=>({ok:true,status:200,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify({currentData:{user:{uid:123,name:'LuoguUser',ccfLevel:0,icpcLevel:1}}})});
  try{
    const api=installLuoguVerification(app,{accounts,authorize:()=>null,saveAccounts:{flush:async()=>{}}});
    const bound=await api.bindByAdmin('Alice',123);assert.equal(bound.name,'LuoguUser');assert.equal(accounts.Alice.verified,true);
    await assert.rejects(()=>api.bindByAdmin('Bob',123),/已经绑定其他/);
    await assert.rejects(()=>api.bindByAdmin('Charlie',123),/另一个玩家账号/);
  }finally{globalThis.fetch=original;}
});
