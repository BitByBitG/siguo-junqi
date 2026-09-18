import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createServer } from 'node:http';
import { debouncedWriter } from './persist.js';

// One saved program may own many seats. Every seat gets a fresh JS worker and memory.
export function installHostedBots({ app, accounts, sessions, server, filename }) {
  // A private loopback transport keeps hosted programs independent of public TLS.
  // It exposes only the authenticated BOT API, never the rest of the website.
  let internalServer, internalReady;
  async function origin() {
    if (!server.listening) throw new Error('服务器尚未启动');
    if (!internalReady) {
      internalServer = createServer((req, res) => {
        if (!req.url.startsWith('/api/bot/')) { res.writeHead(404); res.end(); return; }
        app(req, res);
      });
      internalReady = new Promise((resolve, reject) => {
        internalServer.once('error', reject);
        internalServer.listen(0, '127.0.0.1', () => { internalServer.unref(); resolve(); });
      }).catch(error => { internalServer.close(); internalReady = null; throw error; });
    }
    await internalReady;
    return `http://127.0.0.1:${internalServer.address().port}`;
  }
  server.once('close', () => { internalServer?.close(); internalServer?.closeAllConnections(); });
  let programs;
  try { programs = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(filename, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; programs = Object.create(null); }
  const jobs = new Map(), status = new Map(), tokens = new Map();
  let workers = 0;
  const maxWorkers = Math.max(1, Math.min(8, Number(process.env.BOT_WORKERS) || 2));
  const key = (username, assignmentId = '') => `${username}\u0000${assignmentId}`;
  const save = debouncedWriter(async () => {
    await fsp.mkdir(path.dirname(filename), { recursive: true });
    await fsp.writeFile(filename + '.tmp', JSON.stringify(programs), { mode: 0o600 });
    await fsp.rename(filename + '.tmp', filename);
  });
  function stop(username) {
    for (const [jobKey, job] of jobs) if (jobKey.startsWith(username + '\u0000')) { job.cancelled = true; job.cancel?.(); }
    for (const [tokenKey, token] of tokens) if (tokenKey.startsWith(username + '\u0000')) { sessions.delete(token); tokens.delete(tokenKey); }
  }
  const enabled = username => !!programs[username]?.enabled && !accounts[username]?.blocked;
  const hosted = (username, assignmentId) => enabled(username) && !!assignmentId;
  function run(source, state, validate, budgetMs, job = {}) {
    if (workers >= maxWorkers) return Promise.reject(new Error('计算资源繁忙，请稍后重试'));
    workers++;
    return new Promise((resolve, reject) => {
      let done = false, worker;
      try { worker = new Worker(new URL('./program-worker.js', import.meta.url), { workerData: { source, state, validate, budgetMs }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 } }); }
      catch (error) { workers--; reject(error); return; }
      const finish = (error, value) => {
        if (done) return; done = true; clearTimeout(timer); workers--; worker.terminate();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('程序计算超时')), budgetMs + 250);
      job.cancel = () => finish(new Error('程序已停止'));
      worker.once('message', result => finish(result.ok ? null : new Error(result.error), result.value));
      worker.once('error', finish); worker.once('exit', () => finish(new Error('程序进程已退出')));
    });
  }
  function auth(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const token = String(req.headers.authorization || '').replace(/^Bearer /, ''), session = sessions.get(token);
    if (!session || session.expiresAt < Date.now() || !accounts[session.username]) return res.status(401).json({ error: '请先登录' });
    if (accounts[session.username].type !== 'bot' || accounts[session.username].status === 'pending') return res.status(403).json({ error: '仅已审核 BOT 账号可管理程序' });
    req.username = session.username; next();
  }
  app.get('/api/program', auth, (req, res) => {
    const rows = [...status.entries()].filter(([k]) => k.startsWith(req.username + '\u0000')).map(([k, value]) => ({ assignmentId: k.slice(req.username.length + 1), ...value }));
    res.json({ source: programs[req.username]?.source || '', enabled: enabled(req.username), assignments: rows, ...(status.get(key(req.username)) || {}) });
  });
  app.put('/api/program', auth, async (req, res) => {
    const source = req.body?.source;
    if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 1024 * 1024) return res.status(400).json({ error: '程序不能为空，最大 1 MiB' });
    const account = accounts[req.username];
    try {
      await run(source, null, true, 750);
      if (accounts[req.username] !== account) return res.status(409).json({ error: '账号已变化，请重新登录' });
      stop(req.username);
      for (const k of status.keys()) if (k.startsWith(req.username + '\u0000')) status.delete(k);
      programs[req.username] = { source, enabled: false }; await save.flush();
      status.set(key(req.username), { message: '已保存，点击启动托管', updatedAt: Date.now() }); res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/api/program/run', auth, async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须为布尔值' });
    const program = programs[req.username]; if (!program) return res.status(400).json({ error: '请先保存程序' });
    stop(req.username); program.enabled = req.body.enabled; await save.flush();
    status.set(key(req.username), { message: program.enabled ? '已启动，等待房主分配位置' : '已停止', updatedAt: Date.now() });
    res.json({ ok: true, enabled: program.enabled });
  });
  async function api(username, assignmentId, route, body, method) {
    const tokenKey = key(username, assignmentId); let token = tokens.get(tokenKey);
    if (!token || !sessions.has(token) || sessions.get(token).expiresAt < Date.now()) {
      token = crypto.randomBytes(24).toString('base64url'); tokens.set(tokenKey, token);
      sessions.set(token, { username, hosted: true, assignmentId: assignmentId || null, expiresAt: Date.now() + 86400000 });
    }
    const response = await fetch(`${await origin()}${route}`, { method: method || (body ? 'POST' : 'GET'),
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(2000) });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error); error.status = response.status; throw error; }
    return data;
  }
  async function tick(username, assignment, program) {
    const jobKey = key(username, assignment.assignmentId), job = { cancelled: false }; jobs.set(jobKey, job);
    try {
      const state = await api(username, assignment.assignmentId, `/api/bot/rooms/${assignment.code}`);
      const previous = status.get(jobKey) || {}, memory = previous.memory ?? null, prepared = previous.prepared;
      const drawPending=!state.eliminated&&state.phase==='playing'&&state.drawOffer&&!state.drawOffer.accepted.includes(state.viewerSeat)&&previous.reviewedDraw!==state.drawOffer.id;
      if (job.cancelled || (state.eliminated&&!drawPending) || state.phase === 'finished') return;
      if ((state.phase === 'setup' && state.ready) || (state.phase === 'playing' && state.turn !== state.viewerSeat&&!drawPending)) return;
      const drawOnly=!!drawPending&&(state.eliminated||state.turn!==state.viewerSeat);
      const budgetMs = drawOnly?500:state.phase === 'playing' ? Math.max(1, state.deadline - state.serverTime - 650) : 1500;
      if (workers >= maxWorkers) return;
      const result = await run(program.source, { ...state, drawOnly, memory, programPrepared: !!prepared, thinkTimeMs: Math.max(1, budgetMs - 150) }, false, budgetMs, job);
      if (job.cancelled || !enabled(username)) return;
      if(drawOnly&&result?.action!=='draw'){status.set(jobKey,{...previous,reviewedDraw:state.drawOffer.id});return;}
      if (!result || typeof result !== 'object' || !['setup', 'ready', 'move', 'resign','draw'].includes(result.action)) throw new Error('act(state) 须返回 setup、ready、move、resign 或 draw 操作');
      if (result.memory !== undefined && JSON.stringify(result.memory).length > 16384) throw new Error('memory 最大 16 KB');
      const body = { assignmentId: state.assignmentId, revision: state.revision, requestId: crypto.randomUUID() };
      if (result.action === 'setup') body.pieces = result.pieces;
      if (result.action === 'ready') body.ready = result.ready;
      if (result.action === 'move') Object.assign(body, { from: result.from, to: result.to });
      if (result.action === 'draw') Object.assign(body,{accept:result.accept,offerId:result.offerId});
      await api(username, assignment.assignmentId, `/api/bot/rooms/${state.code}/${result.action}`, body);
      if (!job.cancelled) status.set(jobKey, { message: `已提交 ${result.action} · ${state.code} / ${state.viewerSeat}`, updatedAt: Date.now(), prepared: result.action === 'setup' || !!prepared, memory: result.memory ?? memory });
    } catch (error) {
      if (!job.cancelled) status.set(jobKey, { ...(status.get(jobKey) || {}), message: error.message, error: true, updatedAt: Date.now() });
    } finally { if (jobs.get(jobKey) === job) jobs.delete(jobKey); }
  }
  async function scan(username, program) {
    const scanKey = key(username, '$scan'); if (jobs.has(scanKey)) return;
    const scanJob = { cancelled: false }; jobs.set(scanKey, scanJob);
    try {
      const session = await api(username, null, '/api/bot/session');
      if (scanJob.cancelled || !enabled(username) || programs[username] !== program) return;
      status.set(key(username), {message:`托管连接正常 · 已分配 ${session.assignments?.length || 0} 个位置`, error:false, updatedAt:Date.now()});
      for (const assignment of session.assignments || []) {
        const jobKey = key(username, assignment.assignmentId);
        if (!jobs.has(jobKey) && workers < maxWorkers) tick(username, assignment, program);
      }
    } catch (error) { if(!scanJob.cancelled) status.set(key(username), { message: error.message, error: true, updatedAt: Date.now() }); }
    finally { if(jobs.get(scanKey)===scanJob) jobs.delete(scanKey); }
  }
  const timer = setInterval(() => {
    for (const [username, program] of Object.entries(programs)) if (program.enabled && accounts[username]?.type === 'bot') scan(username, program);
  }, 200);
  timer.unref();
  server.once('close', () => {clearInterval(timer);for(const username of Object.keys(programs))stop(username);});
  return { enabled, hosted, remove(username) { stop(username); delete programs[username]; for (const k of status.keys()) if (k.startsWith(username + '\u0000')) status.delete(k); return save.flush(); }, flushSave: () => save.flush() };
}
