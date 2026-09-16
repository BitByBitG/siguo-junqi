import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchSecureEvent} from '../public/secure-events.js';
test('terminal notifications survive disconnect without replaying stale room state',()=>{
  const events=[],socket={connected:true,id:'old',emitEvent:args=>events.push(args)};
  const send=(event,args=[],id='old')=>dispatchSecureEvent(socket,{event,args},id);
  send('room-state',[1]);
  socket.connected=false;socket.id=undefined;
  for(const event of ['session-replaced','account-deleted','room-closed','kicked'])send(event);
  send('room-state',[2]);
  socket.connected=true;socket.id='new';
  send('session-replaced');send('room-state',[3],'new');
  assert.deepEqual(events,[['room-state',1],['session-replaced'],['account-deleted'],['room-closed'],['kicked'],['room-state',3]]);
});
