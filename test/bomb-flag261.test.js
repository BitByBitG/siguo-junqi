import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {resolveBattle} from '../server/game.js';
test('bomb and flag both die; ordinary capture and bomb combat remain correct',()=>{
 assert.equal(resolveBattle({type:'bomb'},{type:'flag'}),'both');
 assert.equal(resolveBattle({type:'engineer'},{type:'flag'}),'attacker');
 assert.equal(resolveBattle({type:'bomb'},{type:'commander'}),'both');
 assert.equal(resolveBattle({type:'bomb'},null),'move');
});
test('bomb flag capture removes both pieces and eliminates flag owner',()=>{
 const source=fs.readFileSync(new URL('../server/server.js',import.meta.url),'utf8');
 const start=source.indexOf('    let message = `${SEAT_NAMES[attacker.owner]}移动了一枚棋子`;');
 const end=source.indexOf('    const attackerName =',start);
 const attacker={type:'bomb',owner:'north',position:'north-1-0'},defender={type:'flag',owner:'south',position:'south-5-1'};
 const eliminated=[];vm.runInNewContext(source.slice(start,end),{attacker,defender,outcome:resolveBattle(attacker,defender),to:defender.position,room:{},SEAT_NAMES:{north:'北',south:'南'},revealFlagWhenCommanderDies(){},eliminate:(_,seat)=>eliminated.push(seat)});
 assert.equal(attacker.position,null);assert.equal(defender.position,null);assert.deepEqual(eliminated,['south']);
});
