const terminalEvents=new Set(['session-replaced','account-deleted','room-closed','kicked']);
// Decryption may finish after disconnect; terminal notifications must not be buffered forever.
export function dispatchSecureEvent(socket,value,connectionId){
  if(socket.connected&&socket.id!==connectionId)return;
  if(socket.connected||terminalEvents.has(value.event))socket.emitEvent([value.event,...value.args]);
}
