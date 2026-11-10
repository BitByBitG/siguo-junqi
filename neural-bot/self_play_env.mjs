import readline from 'node:readline';
import {BOARD, PIECE_INFO, SEATS, createArmy, publicBoard, resolveBattle, validateMove, sameTeam} from '../server/game.js';

let room;

function reset(mode='ffa'){
  const pieces=SEATS.flatMap(seat=>createArmy(seat).map(piece=>({...piece,initialPosition:piece.position,moved:false,revealed:false})));
  room={phase:'playing',mode,activeSeats:[...SEATS],turn:'north',pieces,players:SEATS.map(seat=>({seat,eliminated:false})),
    ply:0,noCapturePly:0,initialPlayerCount:4,totalPlyLimit:512,battles:[],lastMove:null,winner:null,drawn:false};
  return stateFor(room.turn);
}

function livingSeats(){return SEATS.filter(seat=>room.pieces.some(piece=>piece.owner===seat&&piece.position));}
function player(seat){return room.players.find(item=>item.seat===seat);}
function eliminate(seat){
  if(player(seat).eliminated)return;
  player(seat).eliminated=true;
  for(const piece of room.pieces)if(piece.owner===seat)piece.position=null;
}
function legalMoves(seat){
  if(room.phase!=='playing'||room.turn!==seat||player(seat).eliminated)return [];
  const moves=[];
  for(const piece of room.pieces.filter(p=>p.owner===seat&&p.position&&!PIECE_INFO[p.type].immobile))
    for(const node of BOARD.nodes)if(validateMove(room,seat,piece.position,node.id).ok)moves.push({from:piece.position,to:node.id});
  return moves;
}
function checkWinner(){
  const living=livingSeats();
  if(room.mode==='alliance'){
    const ns=living.filter(seat=>seat==='north'||seat==='south'),ew=living.filter(seat=>seat==='east'||seat==='west');
    if(!ns.length||!ew.length){room.phase='finished';room.winner=ns.length?'南北联盟':'东西联盟';}
  }else if(living.length<=1){room.phase='finished';room.winner=living[0]||'无人';}
}
function advance(){
  if(room.phase!=='playing')return;
  let current=SEATS.indexOf(room.turn);
  for(let checked=0;checked<SEATS.length;checked++){
    current=(current+1)%SEATS.length;
    const seat=SEATS[current];
    if(player(seat).eliminated)continue;
    room.turn=seat;
    if(legalMoves(seat).length)return;
    eliminate(seat);checkWinner();
    if(room.phase!=='playing')return;
  }
  room.phase='finished';room.winner='无人';
}
function move(from,to){
  if(room.phase!=='playing')throw Error('对局已经结束');
  const seat=room.turn,validation=validateMove(room,seat,from,to);
  if(!validation.ok)throw Error(validation.message);
  const attacker=validation.attacker,defender=validation.defender,outcome=resolveBattle(attacker,defender);
  const attackerType=attacker.type,defenderType=defender?.type,defenderOwner=defender?.owner;
  if(defender)room.noCapturePly=0;else room.noCapturePly++;
  attacker.moved=true;if(validation.engineerTurn)attacker.revealed=true;
  if(outcome==='move'||outcome==='attacker'){
    if(defender)defender.position=null;
    attacker.position=to;attacker.moved=true;
  }else if(outcome==='defender')attacker.position=null;
  else {attacker.position=null;if(defender)defender.position=null;}
  room.battles.push({attacker:attacker.id,defender:defender?.id||null,outcome});
  const commanderOwners=[];
  if(attackerType==='commander'&&['defender','both'].includes(outcome))commanderOwners.push(seat);
  if(defenderType==='commander'&&['attacker','both'].includes(outcome))commanderOwners.push(defenderOwner);
  for(const owner of commanderOwners){const flag=room.pieces.find(p=>p.owner===owner&&p.type==='flag'&&p.position);if(flag)flag.revealed=true;}
  if(defenderType==='flag'&&!defender.position)eliminate(defenderOwner);
  room.lastMove={seat,from,to,outcome};room.ply++;
  checkWinner();
  if(room.phase==='playing'&&(room.noCapturePly>=16||room.ply>=room.totalPlyLimit)){
    room.phase='finished';room.drawn=true;room.winner='和棋';
  }
  if(room.phase==='playing')advance();
  return stateFor(room.phase==='playing'?room.turn:seat);
}
function stateFor(viewerSeat){
  const project=piece=>({id:piece.id,owner:piece.owner,position:piece.position,initialPosition:piece.initialPosition,
    moved:!!piece.moved,type:piece.owner===viewerSeat||piece.revealed?piece.type:null,revealed:!!piece.revealed});
  const records=room.pieces.map(project),pieces=records.filter(piece=>piece.position);
  return {apiVersion:1,ruleset:'siguo-custom-v1',code:'SELF',assignmentId:viewerSeat,revision:room.ply,
    viewerSeat,phase:room.phase,turn:room.turn,mode:room.mode,activeSeats:[...SEATS],
    occupiedSeats:room.players.filter(p=>!p.eliminated).map(p=>p.seat),livingSeats:livingSeats(),ready:true,
    eliminated:player(viewerSeat).eliminated,winner:room.winner,lastMove:room.lastMove,drawn:room.drawn,
    ply:room.ply,noCapturePly:room.noCapturePly,initialPlayerCount:4,totalPlyLimit:room.totalPlyLimit,
    pieces,records,battles:room.battles,legalMoves:legalMoves(viewerSeat)};
}

const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){
  try{
    const command=JSON.parse(line);let value;
    if(command.action==='board')value={...publicBoard(),pieceInfo:PIECE_INFO};
    else if(command.action==='reset')value=reset(command.mode);
    else if(command.action==='move')value=move(command.from,command.to);
    else if(command.action==='state')value=stateFor(command.seat||room.turn);
    else throw Error('未知操作');
    process.stdout.write(JSON.stringify({ok:true,value})+'\n');
  }catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n');}
}
