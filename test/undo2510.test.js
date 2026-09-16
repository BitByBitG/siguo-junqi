import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server/server.js',import.meta.url),'utf8');
const ctx={};vm.runInNewContext(source.slice(source.indexOf('function rosterSignature('),source.indexOf('function applyMove(')),ctx);
for(const [label,dead]of [['quiet',[]],['capture',['b']],['attacker dies',['a']],['mutual death',['a','b']],['elimination',['c']]])test('undo: '+label,()=>{
 const player={seat:'north',username:'alice'},before=['a','b','c'].map(id=>({id,position:id}));
 const room={phase:'playing',ply:1,players:[player],turn:'south',eliminationOrder:[],pieces:before.map(p=>({...p,position:dead.includes(p.id)?null:p.id+'2'}))};
 room.undo={seat:'north',username:'alice',ply:1,roster:ctx.rosterSignature(room),after:ctx.undoBoardSignature(room),state:{pieces:before}};
 assert.equal(ctx.canUndo(room,player),!dead.length);
 if(!dead.length){room.ply++;assert.equal(ctx.canUndo(room,player),false);}
});
