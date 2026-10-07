import test from 'node:test';
import assert from 'node:assert/strict';
import {BOARD,activeSeats,createLandlordDeal,completeLandlordDeal,createMachineRoomArmy,machineRoomFlagCanReroll,validateSetup,validateMove,resolveBattle} from '../server/game.js';

test('机房随机忽略普通布阵限制并允许可移动棋子走出大本营',()=>{
  const army=createMachineRoomArmy('north');
  assert.equal(army.length,25);
  assert.equal(new Set(army.map(p=>p.position)).size,25);
  assert.equal(army.every(p=>{const n=BOARD.byId.get(p.position);return n?.seat==='north'&&n.kind!=='camp';}),true);
  assert.equal(validateSetup(army,'north',{mode:'machine_random'}).ok,true);
  const movable={id:'army',owner:'north',type:'army',position:'north-5-1'};
  const room={phase:'playing',turn:'north',mode:'machine_random',activeSeats:activeSeats(4),pieces:[movable]};
  assert.equal(validateMove(room,'north','north-5-1','north-5-0').ok,true);
  assert.equal(validateMove({...room,mode:'ffa'},'north','north-5-1','north-5-0').ok,false);
  assert.equal(machineRoomFlagCanReroll([{owner:'north',type:'flag',position:'north-1-2'}],'north'),true);
  assert.equal(machineRoomFlagCanReroll([{owner:'north',type:'flag',position:'north-3-0'}],'north'),true);
  assert.equal(machineRoomFlagCanReroll([{owner:'north',type:'flag',position:'north-5-1'}],'north'),false);
});

test('斗地主发牌、布阵和特殊棋规则',()=>{
  const seats=activeSeats(4),deal=createLandlordDeal(seats);
  assert.equal(deal.reserve.length,20);
  for(const seat of seats){
    const hand=deal.pieces.filter(p=>p.owner===seat);
    assert.equal(hand.length,20);
    assert.equal(hand.filter(p=>p.type==='flag').length,1);
    assert.equal(hand.filter(p=>p.type==='mine').length<10,true);
  }
  const pieces=completeLandlordDeal(deal.pieces,deal.reserve,seats,'north');
  for(const seat of seats){
    const own=pieces.filter(p=>p.owner===seat);
    assert.equal(own.length,seat==='north'?39:25);
    assert.equal(validateSetup(pieces,seat,{mode:'landlord',landlordSeat:'north'}).ok,true);
    assert.equal(own.filter(p=>p.type==='flag').length,1);
    if(seat!=='north'){
      assert.equal(own.filter(p=>p.type==='platoon').length>=5,true);
      assert.equal(own.find(p=>p.type==='flag').revealed,false);
      assert.equal(own.filter(p=>p.type==='mine').length<10,true);
    }
  }
  assert.equal(pieces.filter(p=>p.owner==='north'&&BOARD.byId.get(p.position)?.kind==='camp').length,5);
  for(const type of ['marshal','missile','fortress'])assert.equal(pieces.filter(p=>p.owner==='north'&&p.type===type).length<=1,true);
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
