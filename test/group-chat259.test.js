import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server/server.js',import.meta.url),'utf8');
function fixture(){
 const routes={},groups={one:{chat:[{id:'a',text:'hello',name:'alice'},{id:'b',text:'bye',name:'alice'}],muted:[]},two:{chat:[{id:'a',text:'private'}],muted:[]}};
 const context={app:{get:(p,f)=>routes[p]=f,post:(p,f)=>{for(const route of Array.isArray(p)?p:[p])routes[route]=f;}},authorizeRequest:r=>r.user,adminKeyMatches:r=>r.key==='secret',isSuperAdmin:n=>n==='root',cleanGroupId:x=>x,groupData:{groups},accountProfile:()=>({}),accounts:{alice:{groupId:'one'},root:{groupId:'one'},bob:{groupId:'two'}},normalizeAccount:()=>{},canonicalUsername:x=>x,globalBans:[],saveLobbyModeration:{flush:async()=>{}},EMOJIS:['☺'],crypto:{},Date,Set};
 vm.runInNewContext(source.slice(source.indexOf("app.get('/api/admin/groups/:id/chat'"),source.indexOf("app.get('/api/groups',")),context);
 vm.runInNewContext(source.slice(source.indexOf("app.post(['/api/groups/:id/chat/action'"),source.indexOf("app.post('/api/admin/groups',")),context);
 const call=async(path,req)=>{const res={code:200,status(n){this.code=n;return this},set(){return this},json(x){this.body=x;return this}};await routes[path]({params:{id:'one'},body:{},...req},res);return res;};return{call,groups};
}
test('group moderation accepts admin key, rejects unrelated users, scopes bulk deletion and mute',async()=>{
 const {call,groups}=fixture(),get='/api/admin/groups/:id/chat',post='/api/groups/:id/chat/action';
 assert.equal((await call(get,{user:{username:'alice'}})).code,403);
 assert.equal((await call(get,{key:'secret'})).body.messages.length,2);
 assert.equal((await call(post,{user:{username:'bob'},body:{action:'delete',ids:['a']}})).code,403);
 assert.equal((await call(post,{key:'secret',body:{action:'delete',ids:['a','b']}})).code,200);
 assert.equal(groups.one.chat.length,0);assert.equal(groups.two.chat.length,1);
 await call(post,{key:'secret',body:{action:'mute',username:'alice'}});assert.equal(groups.one.muted[0],'alice');
 await call(post,{key:'secret',body:{action:'unmute',username:'alice'}});assert.equal(groups.one.muted.length,0);
 assert.equal((await call(post,{key:'secret',body:{action:'recall',messageId:'a'}})).code,403);
});
test('admin account outside target group can mute and unmute without an admin key',async()=>{
 const {call,groups}=fixture();
 for(const route of ['/api/groups/:id/chat/action','/api/admin/groups/:id/chat/action']){
  const req={user:{username:'root'},params:{id:'two'},body:{action:'mute',username:'bob'}};
  assert.equal((await call(route,req)).code,200);assert.deepEqual(groups.two.muted,['bob']);assert.deepEqual(groups.one.muted,[]);
  assert.equal((await call(route,{...req,body:{action:'unmute',username:'bob'}})).code,200);assert.deepEqual(groups.two.muted,[]);
 }
 assert.equal((await call('/api/groups/:id/chat/action',{user:{username:'alice'},params:{id:'two'},body:{action:'mute',username:'bob'}})).code,403);
});
test('shared ten-line folding retains expansion and measures long messages',()=>{
 const common=fs.readFileSync(new URL('../public/chat-common.js',import.meta.url),'utf8');
 const make=()=>{const classes=new Set();return{scrollHeight:250,classList:{add:x=>classes.add(x),contains:x=>classes.has(x),toggle(x,on){if(on??!classes.has(x))classes.add(x);else classes.delete(x)}},setAttribute(){},addEventListener(){}}};
 const context={Set,WeakMap,document:{createElement:make},requestAnimationFrame:f=>f(),getComputedStyle:()=>({lineHeight:'20'})};
 vm.runInNewContext(common.slice(common.indexOf('const expandedMessages')).replaceAll('export function','function'),context);
 const row={children:[],append(x){this.children.push(x)}},body=make();context.attachChatFold(row,body,'group:one:a');
 const toggle=row.children[0];assert.equal(toggle.hidden,false);assert.equal(toggle.textContent,'展开全文');toggle.onclick();assert.equal(toggle.textContent,'收起');
 const next={children:[],append(x){this.children.push(x)}};context.attachChatFold(next,make(),'group:one:a');assert.equal(next.children[0].textContent,'收起');
});
