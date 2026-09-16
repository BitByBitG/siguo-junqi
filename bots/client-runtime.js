import { createSecureClient } from './secure-client.js';
// Included in reference-bot.mjs by scripts/build-reference-bot.js.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) {
  const result = chooseStrongMove(workerData.view, workerData.history, { budgetMs: workerData.budgetMs,
    onProgress: move => parentPort.postMessage({ kind: 'progress', move }) });
  parentPort.postMessage({ kind: 'done', move: result.move });
} else {
  const baseUrl = (process.env.BOT_SERVER || 'http://localhost:3000').replace(/\/$/, '');
  const encryptedFetch=createSecureClient(baseUrl).fetch;
  const username = process.env.BOT_USERNAME, password = process.env.BOT_PASSWORD, requestedAssignment = process.env.BOT_ASSIGNMENT_ID;
  if (!username || !password) {
    console.error('设置 BOT_SERVER、BOT_USERNAME、BOT_PASSWORD 后运行 node reference-bot.mjs');
    process.exitCode = 1;
  } else {
    let token = null, stopped = false, activeWorker = null, assignment = null, prepared = false, history = [];
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    process.on('SIGINT', () => { stopped = true; activeWorker?.terminate(); });
    process.on('SIGTERM', () => { stopped = true; activeWorker?.terminate(); });
    async function http(route, payload) {
      const response = await encryptedFetch(baseUrl + route, { method: payload ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(3000) });
      const body = await response.json();
      if (!response.ok) { const error = new Error(body.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
      return body;
    }
    async function submit(state, action, payload) {
      const body = { ...payload, assignmentId: state.assignmentId, revision: state.revision, requestId: crypto.randomUUID() };
      try { return await http(`/api/bot/rooms/${state.code}/${action}`, body); }
      catch (error) {
        if (error.status || stopped) throw error;
        // An uncertain network result is retried with the SAME idempotency key.
        return http(`/api/bot/rooms/${state.code}/${action}`, body);
      }
    }
    function think(state, budgetMs) {
      return new Promise(resolve => {
        let best = state.legalMoves[0] || null, done = false;
        const worker = new Worker(new URL(import.meta.url), { workerData: { view: state, history, budgetMs } });
        activeWorker = worker;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); worker.terminate(); activeWorker = null; resolve(best); };
        const timer = setTimeout(finish, budgetMs + 60);
        worker.on('message', message => {
          if (state.legalMoves.some(m => m.from === message.move?.from && m.to === message.move?.to)) best = message.move;
          if (message.kind === 'done') finish();
        });
        worker.once('error', finish); worker.once('exit', finish);
      });
    }
    console.log(`BOT ${username} 等待房主分配座位`);
    while (!stopped) {
      try {
        if (!token) {
          token = (await http('/api/bot/login', { username, password })).token;
          const meta = await http('/api/bot/board');
          if (meta.ruleset !== 'siguo-custom-v1') throw new Error('此程序不支持服务器的棋盘规则');
        }
        const session = await http('/api/bot/session');
        const options = session.assignments || (session.assignment ? [session.assignment] : []);
        const selected = requestedAssignment ? options.find(item => item.assignmentId === requestedAssignment) : options[0];
        if (!selected) { assignment = null; console.log(options.length > 1 ? '该账号有多个座位；设置 BOT_ASSIGNMENT_ID 选择其中一个' : '等待房主分配座位'); await delay(500); continue; }
        if (assignment !== selected.assignmentId) {
          assignment = selected.assignmentId; prepared = false; history = [];
          console.log(`已落座 ${selected.code} / ${selected.seat}`);
        }
        let state = await http(`/api/bot/rooms/${selected.code}?assignmentId=${encodeURIComponent(selected.assignmentId)}`);
        if (state.phase === 'setup' && !state.ready) {
          if (!prepared) {
            const army = createStrongArmy(state.viewerSeat);
            const own = state.pieces.filter(p => p.owner === state.viewerSeat);
            const slots = new Map(Object.keys(PIECE_INFO).map(t => [t, army.filter(p => p.type === t).map(p => p.position)]));
            const pieces = own.map(p => ({ id: p.id, position: slots.get(p.type).pop() }));
            await submit(state, 'setup', { pieces }); prepared = true;
            state = await http(`/api/bot/rooms/${state.code}?assignmentId=${encodeURIComponent(state.assignmentId)}`);
          }
          await submit(state, 'ready', { ready: true }); console.log('布阵完成，已准备');
        } else if (state.phase === 'playing' && state.turn === state.viewerSeat && !state.eliminated && state.legalMoves.length) {
          const remaining = state.deadline - state.serverTime;
          const configured = Number(process.env.BOT_THINK_MS) || 3800;
          const budgetMs = Math.max(1, Math.min(4000, configured, remaining - 700));
          const move = remaining < 300 ? state.legalMoves[0] : await think(state, budgetMs);
          if (stopped) break;
          await submit(state, 'move', move);
          history = [...history, move].slice(-16);
          console.log(`${move.from} → ${move.to}`);
        }
        await delay(200);
      } catch (error) {
        if (error.status === 401) token = null;
        if (!stopped) console.error(error.message);
        await delay(error.status === 409 || error.status === 403 ? 300 : 1000);
      }
    }
  }
}
