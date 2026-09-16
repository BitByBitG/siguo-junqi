// A step is one accepted move, not a full round or a request attempt.
export function initDrawCounters(room) {
  room.initialPlayerCount ??= room.capacity || room.activeSeats?.length || room.players.length;
  room.hasBotParticipant ||= room.players.some(p=>p.isBot);
  if(!Number.isInteger(room.noCapturePly)){
    room.noCapturePly=0;
    const logs=room.replay?.logs||[];
    for(let i=logs.length-1;i>=0;i--){const log=logs[i];if(log.tone==='danger')break;if(log.kind!=='move')continue;if(log.defender||log.outcome!=='move')break;room.noCapturePly++;}
  }
  delete room.botQuietMoves;
}
export function recordBotActivity(room, casualty=false) {
  room.noCapturePly=casualty?0:(room.noCapturePly||0)+1;
}
export function autoDrawReason(room) {
  if(room.phase!=='playing'||!(room.hasBotParticipant||room.players.some(p=>p.isBot)))return null;
  if((room.ply||0)>=room.initialPlayerCount*128)return 'move-limit';
  if(room.noCapturePly>=16)return 'no-capture';
  return null;
}
