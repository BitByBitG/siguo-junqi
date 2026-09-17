import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runBatch,installBatch,addSelection} from '../public/admin-batch.js';
import {copySourceButton,renderMutedUsers} from '../public/chat-controls.js';

class Element{
  constructor(tag){this.tag=tag;this.children=[];this.checked=false;this.disabled=false;this.attributes={};}
  append(...nodes){this.children.push(...nodes);}
  prepend(...nodes){this.children.unshift(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(k,v){this.attributes[k]=v;}
  querySelectorAll(selector){const all=this.children.filter(x=>x instanceof Element).flatMap(x=>[x,...x.querySelectorAll('*')]);return all.filter(x=>selector==='*'||selector==='.admin-pick'&&x.className==='admin-pick'||selector==='button,input,select'&&['button','input','select'].includes(x.tag));}
}
globalThis.document={createElement:tag=>new Element(tag),createTextNode:s=>s};
test('batch keeps failures isolated and returns each result',async()=>{
 const calls=[];const results=await runBatch(['a','b','c'],async id=>{calls.push(id);if(id==='b')throw Error('无权限');});
 assert.deepEqual(calls,['a','b','c']);assert.deepEqual(results.map(r=>r.ok),[true,false,true]);assert.equal(results[1].error,'无权限');
});
test('select all/unselect, manual selection, confirm and execute only selected',async()=>{
 const list=new Element('div');for(const id of ['a','b']){const row=new Element('div');addSelection(row,id);list.append(row);}
 const calls=[],status={},refresh=[];globalThis.confirm=()=>true;
 installBatch(list,[{text:'删除',run:async id=>calls.push(id)}],async()=>refresh.push(true),status);
 const bar=list.children[0],all=bar.children[0].children[0],button=bar.children[2];
 assert.equal(button.disabled,true);all.checked=true;all.onchange();assert.equal(button.disabled,false);assert.ok(list.querySelectorAll('.admin-pick').every(p=>p.checked));
 all.checked=false;all.onchange();assert.ok(list.querySelectorAll('.admin-pick').every(p=>!p.checked));
 list.querySelectorAll('.admin-pick')[1].checked=true;list.onchange();assert.equal(all.indeterminate,true);
 await button.onclick();assert.deepEqual(calls,['b']);assert.equal(refresh.length,1);assert.match(status.textContent,/成功 1，失败 0/);
});
test('copy uses exact Markdown and LaTeX source; mute control shared',async()=>{
 const text='**粗体**\n$$a^2+b^2$$\n![](https://example.com/a.png)';let copied;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>copied=value}}});
 const button=copySourceButton(text);await button.onclick();assert.equal(copied,text);assert.equal(button.textContent,'已复制');
 const panel=new Element('div');let target;renderMutedUsers(panel,['alice'],u=>target=u);assert.equal(panel.children[0],'已禁言：');panel.children[1].onclick();assert.equal(target,'alice');renderMutedUsers(panel,[],()=>{});assert.equal(panel.hidden,true);
});
test('chat UI removes global mute entry; group shares home container and muted placement',()=>{
 const read=n=>fs.readFileSync(new URL('../public/'+n,import.meta.url),'utf8');
 const app=read('app.js'),group=read('groups.html'),admin=read('admin.html');
 assert.ok(!app.includes("chatAction(banned"));
 const chat=admin.slice(admin.indexOf('async function loadChat()'),admin.indexOf("document.querySelector('#chat-select-all')"));assert.ok(!chat.includes('全站禁言'));
 assert.match(group,/class="group-page home-main"/);assert.ok(group.indexOf('id="group-muted"')<group.indexOf('id="group-form"'));
 assert.match(admin,/已全站禁言/);assert.match(admin,/addSelection\(row,room.code\)/);assert.match(admin,/addSelection\(row,item.username\)/);
});
