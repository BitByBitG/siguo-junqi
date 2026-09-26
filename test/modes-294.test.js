import test from 'node:test';
import assert from 'node:assert/strict';
import {BOARD,activeSeats,createLandlordArmies,validateSetup,validateMove,resolveBattle} from '../server/game.js';

test('斗地主发牌、布阵和特殊棋规则',()=>{
  const seats=activeSeats(4),pieces=createLandlordArmies(seats,'north');
  for(const seat of seats){
    const own=pieces.filter(p=>p.owner===seat);
    assert.equal(own.length,seat==='north'?35:25);
    assert.equal(validateSetup(pieces,seat,{mode:'landlord',landlordSeat:'north'}).ok,true);
    assert.equal(own.filter(p=>p.type==='flag').length,1);
    if(seat!=='north'){
      assert.equal(own.filter(p=>p.type==='platoon').length>=5,true);
      assert.equal(own.find(p=>p.type==='flag').revealed,false);
      assert.equal(own.filter(p=>p.type==='mine').length<10,true);
    }
  }
  assert.equal(resolveBattle({type:'missile'},{type:'battalion'}),'attacker');
  assert.equal(resolveBattle({type:'missile'},{type:'brigade'}),'both');
  assert.equal(resolveBattle({type:'commander'},{type:'missile'}),'both');
  assert.equal(resolveBattle({type:'platoon'},{type:'missile'}),'defender');
  assert.equal(resolveBattle({type:'commander'},{type:'fortress'}),'defender');
  assert.equal(resolveBattle({type:'bomb'},{type:'fortress'}),'both');
  const moving=[{id:'m',owner:'north',type:'missile',position:'south-4-1'}];
  const room={phase:'playing',turn:'north',mode:'ffa',activeSeats:seats,pieces:moving};
  const move=validateMove(room,'north','south-4-1','east-0-0');
  assert.equal(move.ok,true);assert.equal(move.engineerTurn,true);
  assert.ok(BOARD.byId.has('center-1-1'));
});
