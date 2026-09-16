import crypto from 'node:crypto';
import { BOARD, PIECE_INFO, publicBoard, createArmy, validateSetup, validateMove } from './game.js';

export function installBotApi({ app, rooms, accounts, sessions, emitRoom, addLog, applyMove, eliminate, checkWinner, advanceTurn, voteDraw, isHosted = () => false }) {
  const presence = new Map();
  const findAssignments = username => {
    const result = [];
    for (const room of rooms.values()) for (const player of room.players) {
      if (room.phase !== 'finished' && player.isBot && player.username === username) result.push({ room, player });
    }
    return result;
  };
  const findAssignment = (username, assignmentId) => findAssignments(username)
    .find(item => !assignmentId || item.player.token === assignmentId) || null;
  const directory = () => Object.keys(accounts).filter(name => accounts[name].type === 'bot' && accounts[name].status !== 'pending')
    .sort().map(username => ({ username, rating: accounts[username].rating ?? 1500, online: Date.now() - (presence.get(username) || 0) < 15000,
      seats: findAssignments(username).length }));

  function attach(room, seat, username) {
    if (!accounts[username] || accounts[username].blocked || accounts[username].type !== 'bot' || accounts[username].status === 'pending') return '请选择未封禁且已审核的 BOT 账号';
    const player = { seat, username, name: `BOT · ${username}`, isBot: true, token: crypto.randomUUID(),
      online: Date.now() - (presence.get(username) || 0) < 15000, socketId: null, ready: room.phase === 'playing', eliminated: false,
      requests: new Map() };
    room.players.push(player);
    if(room.phase==='playing')room.hasBotParticipant=true;
    if (room.phase === 'setup') room.pieces.push(...createArmy(seat));
    addLog(room, `BOT ${username} 加入${seat}`);
    return null;
  }

  function update(room) {
    // Chat, heartbeats and observer activity do not invalidate a pending move.
    const signature = JSON.stringify([room.phase, room.turn, room.ply || 0, room.drawOffer,
      room.players.map(p => [p.seat, p.token, p.ready, p.eliminated]),
      room.pieces.map(p => [p.id, p.position, !!p.revealed])]);
    if (signature !== room.botSignature) { room.botSignature = signature; room.revision = (room.revision || 0) + 1; }
    const current = room.players.find(p => p.seat === room.turn && p.isBot && !p.eliminated);
    const key = room.phase === 'playing' && current && rooms.get(room.code) === room ? `${room.ply || 0}:${current.token}` : null;
    if (room.botClock?.key === key) return;
    if (room.botClock) clearTimeout(room.botClock.timer);
    room.botClock = null;
    if (!key) return;
    const clock = { key, deadline: Date.now() + 5000 };
    room.botClock = clock;
    clock.timer = setTimeout(() => {
      if (room.botClock !== clock || rooms.get(room.code) !== room || room.phase !== 'playing') return;
      eliminate(room, current.seat, 'BOT 超过 5 秒未提交合法着法，判负');
      checkWinner(room); advanceTurn(room); emitRoom(room);
    }, 5000);
    clock.timer.unref();
  }

  function removeAccount(username) {
    for (const { room, player } of findAssignments(username)) {
      room.players = room.players.filter(p => p !== player);
      if (room.phase === 'setup') room.pieces = room.pieces.filter(p => p.owner !== player.seat);
      if (room.turn === player.seat) advanceTurn(room);
      addLog(room, `BOT ${username} 的账号已删除，座位已释放`);
      emitRoom(room);
    }
  }

  app.get('/api/bots', (_req, res) => res.json(directory()));
  app.use('/api/bot', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now() || !accounts[session.username] || accounts[session.username].status === 'pending') return res.status(401).json({ error: '认证已失效' });
    if (accounts[session.username].type !== 'bot') return res.status(403).json({ error: '仅 BOT 账号可使用此接口' });
    req.botUsername = session.username;
    req.botAssignmentId = session.assignmentId || null;
    req.hosted = !!session.hosted;
    const wasOnline = Date.now() - (presence.get(session.username) || 0) < 15000;
    presence.set(session.username, Date.now());
    if (!wasOnline) for (const assigned of findAssignments(session.username)) emitRoom(assigned.room);
    next();
  });
  app.get('/api/bot/board', (_req, res) => res.json({ apiVersion: 1, ruleset: 'siguo-custom-v1', ...publicBoard(),
    straightRailLines: BOARD.straightRailLines, pieceInfo: PIECE_INFO, turnLimitMs: 5000 }));
  app.get('/api/bot/session', (req, res) => {
    const assignments = findAssignments(req.botUsername).filter(item => !req.botAssignmentId || item.player.token === req.botAssignmentId)
      .map(({ room, player }) => ({ code: room.code, seat: player.seat, assignmentId: player.token }));
    // assignment remains for old one-seat clients; new clients use assignments.
    res.json({ apiVersion: 2, username: req.botUsername, assignment: assignments.length === 1 ? assignments[0] : null, assignments });
  });
  function authorized(req, res) {
    const room = rooms.get(req.params.code);
    const assignmentId = req.botAssignmentId || req.query.assignmentId || req.body?.assignmentId;
    const candidates = room?.players.filter(p => p.isBot && p.username === req.botUsername) || [];
    const player = assignmentId ? candidates.find(p => p.token === assignmentId) : candidates.length === 1 ? candidates[0] : null;
    if (!player) {
      if (assignmentId && candidates.length) { res.status(409).json({ error: '座位分配已变化，请重新获取 session' }); return null; }
      const message = candidates.length > 1 ? '同一 BOT 账号有多个座位，请提供 assignmentId' : '该 BOT 未被分配到此房间或座位已变化';
      res.status(403).json({ error: message }); return null;
    }
    player.online = true;
    return { room, player };
  }
  app.get('/api/bot/rooms/:code', (req, res) => {
    const ctx = authorized(req, res); if (!ctx) return;
    const { room, player } = ctx;
    const project = p => ({ id: p.id, owner: p.owner, position: p.position, initialPosition: p.initialPosition || null,
      moved: !!p.moved, type: p.owner === player.seat || p.revealed ? p.type : null });
    const records = room.pieces.map(project).sort((a, b) => a.id.localeCompare(b.id));
    const pieces = records.filter(p => p.position).sort((a, b) => a.position.localeCompare(b.position));
    const legalMoves = [];
    if (room.phase === 'playing' && room.turn === player.seat && !player.eliminated) {
      for (const p of pieces.filter(p => p.owner === player.seat && !PIECE_INFO[p.type].immobile)) {
        for (const n of BOARD.nodes) if (validateMove(room, player.seat, p.position, n.id).ok) legalMoves.push({ from: p.position, to: n.id });
      }
    }
    res.json({ apiVersion: 1, ruleset: 'siguo-custom-v1', code: room.code, assignmentId: player.token, revision: room.revision,
      viewerSeat: player.seat, phase: room.phase, turn: room.turn, mode: room.mode, activeSeats: room.activeSeats,
      occupiedSeats: room.players.filter(p => !p.eliminated).map(p => p.seat),
      livingSeats: room.activeSeats.filter(s => pieces.some(p => p.owner === s)),
      ready: player.ready, eliminated: player.eliminated, winner: room.winner, lastMove: room.lastMove,
      drawOffer:room.drawOffer||null, drawn:!!room.drawn, autoDrawReason:room.autoDrawReason||null,
      ply:room.ply||0, noCapturePly:room.noCapturePly||0, noCapturePlyLimit:16,
      initialPlayerCount:room.initialPlayerCount||room.capacity, totalPlyLimit:(room.initialPlayerCount||room.capacity)*128,
      serverTime: Date.now(), deadline: room.botClock?.deadline || null,
      pieces, records, battles: room.publicBattles || [], legalMoves,
      logs: [...(room.privateLogs.get(player.seat) || []), ...room.logs].sort((a, b) => b.time - a.time).slice(0, 80) });
  });
  app.post('/api/bot/rooms/:code/:action', (req, res) => {
    const ctx = authorized(req, res); if (!ctx) return;
    const { room, player } = ctx, body = req.body || {}, action = req.params.action;
    if (isHosted(req.botUsername, player.token) && !req.hosted) return res.status(409).json({ error: '该座位的网站托管正在运行，请先在 BOT 工作台停止后再使用外部程序' });
    if (!['setup', 'ready', 'move', 'resign', 'draw'].includes(action)) return res.status(404).json({ error: '接口不存在' });
    if (body.assignmentId !== player.token) return res.status(409).json({ error: '座位分配已变化，请重新获取 session' });
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(body.requestId)) return res.status(400).json({ error: '请提供 6–80 位 requestId' });
    const fingerprint = JSON.stringify([action, body]);
    const previous = player.requests.get(body.requestId);
    if (previous) return previous.fingerprint === fingerprint ? res.json(previous.reply) : res.status(409).json({ error: 'requestId 已用于其他请求' });
    if (body.revision !== room.revision) return res.status(409).json({ error: '棋局版本已变化，请重新读取' });
    if ((player.eliminated && action!=='draw') || room.phase === 'finished') return res.status(409).json({ error: '该方向已结束对局' });
    if (room.turn === player.seat && room.botClock && Date.now() >= room.botClock.deadline) return res.status(409).json({ error: '回合已超时' });
    if(action==='draw'){
      const error=voteDraw(room,player,body.accept,body.offerId);if(error)return res.status(409).json({error});
    } else if (action === 'setup') {
      if (room.phase !== 'setup' || player.ready) return res.status(409).json({ error: '只能在未准备时布阵' });
      const own = room.pieces.filter(p => p.owner === player.seat);
      if (!Array.isArray(body.pieces) || body.pieces.length !== 25 || new Set(body.pieces.map(p => p?.id)).size !== 25
        || body.pieces.some(p => !p || typeof p.position !== 'string' || !own.some(q => q.id === p.id))) return res.status(400).json({ error: '必须提交本方全部 25 枚棋子的 id 和位置' });
      const byId = new Map(body.pieces.map(p => [p.id, p.position]));
      const candidate = room.pieces.map(p => p.owner === player.seat ? { ...p, position: byId.get(p.id) } : p);
      const result = validateSetup(candidate, player.seat);
      if (!result.ok) return res.status(400).json({ error: result.message });
      room.pieces = candidate;
    } else if (action === 'ready') {
      if (room.phase !== 'setup' || typeof body.ready !== 'boolean') return res.status(400).json({ error: '布阵阶段提交 ready 布尔值' });
      const result = validateSetup(room.pieces, player.seat);
      if (!result.ok) return res.status(400).json({ error: result.message });
      player.ready = body.ready;
      addLog(room, `${player.name}${player.ready ? '已准备' : '取消准备'}`);
    } else if (action === 'move') {
      const result = applyMove(room, player, body.from, body.to);
      if (!result.ok) return res.status(400).json({ error: result.message });
    } else {
      if (room.phase !== 'playing') return res.status(409).json({ error: '尚未开局' });
      eliminate(room, player.seat, 'BOT 已认输'); checkWinner(room);
      if (room.turn === player.seat) advanceTurn(room);
    }
    if (action !== 'move') emitRoom(room);
    const reply = { ok: true, requestId: body.requestId, revision: room.revision };
    player.requests.set(body.requestId, { fingerprint, reply });
    if (player.requests.size > 128) player.requests.delete(player.requests.keys().next().value);
    res.json(reply);
  });
  return { attach, update, directory, removeAccount, isOnline: username => Date.now() - (presence.get(username) || 0) < 15000 };
}
