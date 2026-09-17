import {atomicWrite,resetRoomsOnce,writeRoomsArchive} from './room-archive.js';
import { ratingClass } from '../public/rating-colors.js';
import { initDrawCounters, recordBotActivity, autoDrawReason } from './bot-activity.js';
import { installSecure } from './secure.js';
import { installImages } from './images.js';
import { installProfiles } from './profiles.js';
import crypto from "node:crypto";
import { emojis as EMOJIS } from '../public/emojis.js';
import { installBotApi } from "./bot-api.js";
import { installHostedBots } from "./hosted-bots.js";
import { debouncedWriter } from "./persist.js";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Server } from "socket.io";
import {
  BOARD,
  PIECE_INFO,
  SEAT_NAMES,
  activeSeats,
  createArmy,
  pieceAt,
  publicBoard,
  resolveBattle,
  revealFlagWhenCommanderDies,
  sameTeam,
  validateMove,
  validateSetup,
  hasLegalMove,
} from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
for(const method of ['get','post','put','patch','delete']){
  const original=app[method].bind(app);
  app[method]=(route,...handlers)=>original(route,...handlers.map(handler=>handler?.constructor?.name==='AsyncFunction'?
    (req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next):handler));
}
const tlsCert = process.env.SIGUO_TLS_CERT, tlsKey = process.env.SIGUO_TLS_KEY;
if (!!tlsCert !== !!tlsKey) throw new Error('SIGUO_TLS_CERT 与 SIGUO_TLS_KEY 必须同时设置');
const server = tlsCert ? createHttpsServer({cert:fs.readFileSync(tlsCert),key:fs.readFileSync(tlsKey)}, app) : createServer(app);
// Only trust X-Forwarded-For when the operator configures a trusted proxy.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const io = new Server(server, {
  serveClient: true,
  transports: ["websocket", "polling"],
  allowRequest: (req, callback) => callback(null, isAllowedOrigin(req.headers.origin, req)),
});
const rooms = new Map();
const sessions = new Map();
const presence = new Map(); // keyed by session token, so logout invalidates presence immediately
const PORT = Number(process.env.PORT || 3000);
const LEGACY_ACCOUNTS_FILE = path.join(__dirname, "../data/accounts.json");
const DATA_DIR = process.env.SIGUO_DATA_DIR || path.join(os.homedir(), ".siguo-junqi");
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(DATA_DIR, "accounts.json");
const MIGRATE_LEGACY_ACCOUNTS = !process.env.ACCOUNTS_FILE && !process.env.SIGUO_DATA_DIR;
const ADMIN_KEY_FILE=path.join(path.dirname(ACCOUNTS_FILE),'admin-key.txt');
const ADMIN_KEY=process.env.ADMIN_KEY||(()=>{
  if(fs.existsSync(ADMIN_KEY_FILE))return fs.readFileSync(ADMIN_KEY_FILE,'utf8').trim();
  const key=crypto.randomBytes(32).toString('base64url');fs.mkdirSync(path.dirname(ADMIN_KEY_FILE),{recursive:true});fs.writeFileSync(ADMIN_KEY_FILE,key,{mode:0o600});return key;
})();
if(ADMIN_KEY.length<12)throw Error('ADMIN_KEY 至少需要 12 位，请更新启动配置');
const LOBBY_CHAT_FILE = path.join(process.env.ACCOUNTS_FILE ? path.dirname(ACCOUNTS_FILE) : DATA_DIR, 'lobby-chat.json');
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { console.error(`[持久化] 读取 ${file} 失败，已回退到空数据:`, error?.message || error); return fallback; }
}
let lobbyChat = readJson(LOBBY_CHAT_FILE, []);
const ANNOUNCEMENTS_FILE = path.join(path.dirname(LOBBY_CHAT_FILE), 'announcements.json');
let announcements = readJson(ANNOUNCEMENTS_FILE, []);
const LOBBY_MUTES_FILE = path.join(path.dirname(LOBBY_CHAT_FILE), 'lobby-mutes.json');
let lobbyMutes = readJson(LOBBY_MUTES_FILE, []);
const GLOBAL_BANS_FILE = path.join(path.dirname(LOBBY_CHAT_FILE), 'bans.json');
let globalBans = readJson(GLOBAL_BANS_FILE, []);
const GROUPS_FILE = path.join(path.dirname(LOBBY_CHAT_FILE), 'groups.json');
let groupData = readJson(GROUPS_FILE, {groups:{default:{id:'default',name:'默认分组',chatPaused:false,playPaused:false,imagesPaused:false,dailyRoomLimit:3,keepRoomHistory:false,chat:[]}}});
if(!groupData || typeof groupData!=='object')groupData={groups:{}};
if(!groupData.groups || typeof groupData.groups!=='object')groupData.groups={};
if(!groupData.groups.default)groupData.groups.default={id:'default',name:'默认分组',chatPaused:false,playPaused:false,imagesPaused:false,dailyRoomLimit:3,keepRoomHistory:false,chat:[],muted:[]};
for(const [id,g] of Object.entries(groupData.groups)){
  g.id=id; g.name=String(g.name||id).slice(0,40); g.chatPaused=!!g.chatPaused; g.playPaused=!!g.playPaused; g.imagesPaused=!!g.imagesPaused;
  if(!Number.isInteger(g.dailyRoomLimit)||g.dailyRoomLimit<0)g.dailyRoomLimit=3; if(typeof g.keepRoomHistory!=='boolean'){
    g.keepRoomHistory=typeof g.keepChatHistory==='boolean'?g.keepChatHistory:false;
  }
  delete g.keepChatHistory;
  if(!Array.isArray(g.chat))g.chat=[]; g.chat=g.chat.slice(-100); if(!Array.isArray(g.muted))g.muted=[];
}
const saveLobbyModeration = debouncedWriter(async () => {
  for (const [file, data] of [[ANNOUNCEMENTS_FILE, announcements], [LOBBY_CHAT_FILE, lobbyChat], [LOBBY_MUTES_FILE, lobbyMutes], [GLOBAL_BANS_FILE, globalBans], [GROUPS_FILE, groupData]]) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + ".tmp", JSON.stringify(data), { mode: 0o600 });
    await fsp.rename(file + ".tmp", file);
  }
});
// 管理员账号通过 accounts[username].admin 标记；0=普通，1=普通，2=管理员，3=管理密钥。
function isSuperAdmin(username) { return !!accounts?.[username]?.admin; }
function userRank(username) { return isSuperAdmin(username) ? 2 : 1; }
const SUPER_RANK = 3;
function changeChat(messages, muted, payload, operatorRank, operatorName) {
  if (payload.action === 'mute' || payload.action === 'unmute') {
    const target = payload.username;
    if (!target || !Object.hasOwn(accounts, target)) return '账号不存在';
    if (isSuperAdmin(target) && operatorRank < SUPER_RANK && target !== operatorName) return '不能对管理员操作';
    const index = muted.indexOf(payload.username);
    if (payload.action === 'mute' && index < 0) muted.push(payload.username);
    if (payload.action === 'unmute' && index >= 0) muted.splice(index,1);
  } else if (payload.action === 'recall') {
    const message = messages.find(m=>m.id===payload.id);
    if (!message) return '消息不存在';
    if (isSuperAdmin(message.name) && operatorRank < SUPER_RANK && message.name !== operatorName) return '不能撤回管理员的消息';
    message.text = '[消息已由管理员撤回]'; message.recalled = true; delete message.reactions;
  } else if (payload.action === 'delete') {
    const ids = new Set(Array.isArray(payload.ids)?payload.ids:[payload.id].filter(Boolean));
    if(!ids.size)return '请选择要删除的消息';
    for(let i=messages.length-1;i>=0;i--)if(ids.has(messages[i].id)){
      if(isSuperAdmin(messages[i].name)&&operatorRank<SUPER_RANK&&messages[i].name!==operatorName)continue;
      messages.splice(i,1);
    }
  } else return '无效操作';
}
function changeBan(banned, payload, operatorRank) {
  const target = payload.username;
  if (!target || !Object.hasOwn(accounts, target)) return '账号不存在';
  if (payload.action === 'unban') payload.banned = false;
  if (payload.action === 'ban') payload.banned = true;
  if (typeof payload.banned !== 'boolean') return '封禁参数无效';
  if (isSuperAdmin(target) && operatorRank < SUPER_RANK) return '不能封禁管理员';
  const index = banned.indexOf(target);
  if (payload.banned && index < 0) banned.push(target);
  if (!payload.banned && index >= 0) banned.splice(index, 1);
  return null;
}
const HISTORY_DIR = process.env.SIGUO_HISTORY_DIR || '/mnt/e/junqi-history';
const ROOMS_FILE = process.env.SIGUO_ROOMS_FILE || path.join(HISTORY_DIR, 'rooms.json');
const legacyRooms = path.join(process.env.ACCOUNTS_FILE ? path.dirname(ACCOUNTS_FILE) : DATA_DIR, 'rooms.json');
function quarantineBrokenJson(file, error) {
  try {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, backup);
    console.error(`[持久化] ${file} 不是有效 JSON，已移到 ${backup}，服务将继续启动:`, error?.message || error);
  } catch (backupError) {
    console.error(`[持久化] ${file} 不是有效 JSON，且无法备份，服务仍将继续启动:`, error?.message || error, backupError?.message || backupError);
  }
}
function loadRoomsArchive() {
  const candidates = [];
  if (fs.existsSync(ROOMS_FILE)) candidates.push(ROOMS_FILE);
  if (fs.existsSync(`${ROOMS_FILE}.tmp`)) candidates.push(`${ROOMS_FILE}.tmp`);
  if (fs.existsSync(`${ROOMS_FILE}.bak`)) candidates.push(`${ROOMS_FILE}.bak`);
  if (!fs.existsSync(ROOMS_FILE+'.reset-2.5.11') && legacyRooms !== ROOMS_FILE && fs.existsSync(legacyRooms)) candidates.push(legacyRooms);
  for (const file of candidates) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!saved || saved.version !== 1 || !Array.isArray(saved.rooms)) throw new Error('房间存档格式错误');
      if (file !== ROOMS_FILE) {
        fs.mkdirSync(path.dirname(ROOMS_FILE), { recursive: true });
        atomicWrite(ROOMS_FILE,JSON.stringify(saved));
        console.warn(`[持久化] 已使用备份存档 ${file} 恢复 ${ROOMS_FILE}`);
      }
      return saved;
    } catch (error) {
      quarantineBrokenJson(file, error);
    }
  }
  return { version: 1, rooms: [] };
}
resetRoomsOnce(ROOMS_FILE);
const savedRooms = loadRoomsArchive();
for (const room of savedRooms.rooms) {
  initDrawCounters(room);
  room.moveTrails ||= room.lastMove?.seat ? {[room.lastMove.seat]:room.lastMove} : {};
  if(typeof room.keepRoomHistory!=='boolean') room.keepRoomHistory=!!room.keepChatHistory;
  delete room.keepChatHistory;
  room.privateLogs = new Map(room.privateLogs || []);
  room.spectators = new Map();
  const formerHost = room.players.filter(p => !p.isBot && p.name === room.hostName);
  if (formerHost.length === 1) room.hostName = formerHost[0].username || formerHost[0].name;
  else if (formerHost.length > 1) room.hostName = null;
  for (const player of room.players) {
    player.socketId = null; player.online = false; player.requests = new Map();
    if (!player.isBot && player.username) player.name = player.username;
  }
  rooms.set(room.code, room);
}
const HISTORY_LIMIT_BYTES = 1024*1024*1024;
const saveRooms = debouncedWriter(async () => {
  let snapshot = [...rooms.values()]
    .filter(room => room.phase !== 'finished' || room.keepRoomHistory)
    .map(room => {
      const { botClock, spectators, privateLogs, ...data } = room;
      return { ...data, privateLogs: [...privateLogs], players: room.players.map(player => ({ ...player, socketId: null, online: false })) };
    });
  let body=JSON.stringify({version:1,rooms:snapshot});
  if(Buffer.byteLength(body)>HISTORY_LIMIT_BYTES){
    const finished=snapshot.filter(r=>r.phase==='finished').sort((a,b)=>(a.finishedAt||a.createdAt||0)-(b.finishedAt||b.createdAt||0));
    const remove=new Set();
    for(const room of finished){if(Buffer.byteLength(body)<=HISTORY_LIMIT_BYTES)break;remove.add(room.code);snapshot=snapshot.filter(r=>!remove.has(r.code));body=JSON.stringify({version:1,rooms:snapshot});}
  }
  writeRoomsArchive(ROOMS_FILE,body);
});
const INITIAL_RATING = 1500;
const RATING_RANKS = [
  [3000, "元帅", "marshal"], [2900, "上将", "general"], [2750, "中将", "general"],
  [2600, "少将", "general"], [2450, "大校", "colonel"], [2300, "上校", "colonel"],
  [2100, "中校", "colonel"], [1900, "少校", "colonel"], [1800, "上尉", "officer"],
  [1700, "中尉", "officer"], [1600, "少尉", "officer"], [1500, "军士长", "sergeant"],
  [1400, "上士", "sergeant"], [1200, "中士", "sergeant"], [1000, "下士", "sergeant"],
  [800, "上等兵", "soldier"], [-Infinity, "列兵", "recruit"],
];

function ratingRank(rating) {
  const [, rank, rankClass] = RATING_RANKS.find(([minimum]) => rating >= minimum);
  return { rank, rankClass: ratingClass(rating) };
}

function normalizeAccount(account) {
  if (!["human", "bot"].includes(account.type)) account.type = "human";
  if (!Object.hasOwn(account, "admin")) account.admin = false;
  if (!Number.isFinite(account.rating)) account.rating = INITIAL_RATING;
  if (!Number.isInteger(account.ratedGames) || account.ratedGames < 0) account.ratedGames = 0;
  if (!Number.isFinite(account.peakRating)) account.peakRating = account.rating;
  if (!Array.isArray(account.ratingHistory)) account.ratingHistory = [];
  if (typeof account.groupId !== 'string' || !groupData.groups[account.groupId]) account.groupId = 'default';
  if (typeof account.roomCreateDay !== 'string') account.roomCreateDay = '';
  if (!Number.isInteger(account.roomCreateCount) || account.roomCreateCount < 0) account.roomCreateCount = 0;
  if (typeof account.signature !== 'string') account.signature = '';
  return account;
}

function accountProfile(username) {
  const account = accounts[username];
  if (!account) return { rating: INITIAL_RATING, ratedGames: 0, peakRating: INITIAL_RATING, ...ratingRank(INITIAL_RATING) };
  normalizeAccount(account);
  const info = ratingRank(account.rating);
  return { blocked:!!account.blocked, globallyMuted:globalBans.includes(username), avatar: account.avatar?.id || null, signature:account.signature||'', accountType: account.type || "human", admin: !!account.admin, rating: account.rating, ratedGames: account.ratedGames, peakRating: account.peakRating, rank: info.rank, rankClass: info.rankClass, groupId:account.groupId||'default', groupName:groupData.groups[account.groupId||'default']?.name||'默认分组' };
}

function loadAccounts() {
  const filenames = MIGRATE_LEGACY_ACCOUNTS ? [ACCOUNTS_FILE, LEGACY_ACCOUNTS_FILE] : [ACCOUNTS_FILE];
  for (const filename of filenames) {
    try { return JSON.parse(fs.readFileSync(filename, "utf8")); }
    catch {}
  }
  return {};
}

const accounts = Object.assign(Object.create(null), loadAccounts());
const namesSeen = new Set();
for (const name of Object.keys(accounts)) {
  const key = name.toLowerCase();
  if (namesSeen.has(key)) throw Error(`用户名大小写冲突：${name}；请先重命名冲突账号，账号数据未修改`);
  namesSeen.add(key);
}
function canonicalUsername(value) {
  const name = String(value || '').trim();
  return Object.keys(accounts).find(key => key.toLowerCase() === name.toLowerCase()) || name;
}

function groupForUser(username){
  const account=accounts[username]; normalizeAccount(account||{});
  return groupData.groups[account?.groupId||'default'] || groupData.groups.default;
}
function groupCan(username,feature){
  if(isSuperAdmin(username))return true;
  const group=groupForUser(username);
  return !group?.[feature+'Paused'];
}
function todayKey(){return new Date().toISOString().slice(0,10);}
function canCreateRoom(username){
  const account=accounts[username]; if(!account)return {ok:false,error:'账号不存在'}; normalizeAccount(account);
  if(!groupCan(username,'play'))return {ok:false,error:'你所在分组已暂停下棋功能'};
  const day=todayKey(); if(account.roomCreateDay!==day){account.roomCreateDay=day;account.roomCreateCount=0;}
  const limit=groupForUser(username)?.dailyRoomLimit??3;
  if(account.roomCreateCount>=limit)return {ok:false,error:`今天创建房间次数已达上限（${limit}）`};
  return {ok:true};
}
function useRoomQuota(username){const a=accounts[username];normalizeAccount(a);const d=todayKey();if(a.roomCreateDay!==d){a.roomCreateDay=d;a.roomCreateCount=0;}a.roomCreateCount++;saveAccounts();}
function cleanGroupId(value){return String(value||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,32);}

const saveAccounts = debouncedWriter(async () => {
  await fsp.mkdir(path.dirname(ACCOUNTS_FILE), { recursive: true });
  await fsp.writeFile(ACCOUNTS_FILE + ".tmp", JSON.stringify(accounts, null, 2), { mode: 0o600 });
  await fsp.rename(ACCOUNTS_FILE + ".tmp", ACCOUNTS_FILE);
});

// 简单内存限流：只对「失败」的认证/注册尝试计数，成功后清零。
// 兼具按 IP（防枚举/爆破）与按 IP+用户名（防单账号撞库）两个维度。
const throttleStore = new Map();
const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const AUTH_IP_FAIL_LIMIT = 25;
const AUTH_USER_FAIL_LIMIT = 8;
const AUTH_BLOCK_MS = 5 * 60 * 1000;
function clientIp(req) {
  // req.ip honors the 'trust proxy' setting: when no trusted proxy is configured
  // it is the socket's real address, and X-Forwarded-For is ignored entirely.
  return req.ip || req.socket?.remoteAddress || "unknown";
}
function throttleLocked(key) {
  const rec = throttleStore.get(key);
  if (!rec) return 0;
  if (rec.blockedUntil > Date.now()) return rec.blockedUntil - Date.now();
  if (rec.resetAt < Date.now()) throttleStore.delete(key);
  return 0;
}
function throttleFail(key, limit) {
  const now = Date.now();
  let rec = throttleStore.get(key);
  if (!rec || rec.resetAt < now) rec = { count: 0, resetAt: now + THROTTLE_WINDOW_MS, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count > limit) rec.blockedUntil = now + AUTH_BLOCK_MS;
  throttleStore.set(key, rec);
}
function throttleBlocked(req, name) {
  const ip = clientIp(req);
  const locked = Math.max(throttleLocked(`auth:${ip}:${name}`), throttleLocked(`auth:${ip}:*`));
  if (locked > 0) return { retryAfter: Math.max(1, Math.ceil(locked / 1000)) };
  return null;
}
function throttleFailAuth(req, name, limit) {
  const ip = clientIp(req);
  throttleFail(`auth:${ip}:${name}`, limit);
  throttleFail(`auth:${ip}:*`, AUTH_IP_FAIL_LIMIT);
}
function throttleClearAuth(req, name) {
  const ip = clientIp(req);
  throttleStore.delete(`auth:${ip}:${name}`);
  throttleStore.delete(`auth:${ip}:*`);
}

if (MIGRATE_LEGACY_ACCOUNTS && !fs.existsSync(ACCOUNTS_FILE) && fs.existsSync(LEGACY_ACCOUNTS_FILE)) await saveAccounts.flush();
let accountDataChanged = false;
for (const account of Object.values(accounts)) {
  const before = JSON.stringify(account);
  normalizeAccount(account);
  if (JSON.stringify(account) !== before) accountDataChanged = true;
}
if (accountDataChanged) await saveAccounts.flush();

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString("hex") };
}
const DUMMY_SALT = crypto.randomBytes(16).toString("hex");

function isAllowedOrigin(origin, req) {
  if (!origin) return true; // server-side / non-browser clients (e.g. test harness)
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host; // same-origin browser connections
  } catch {
    return false;
  }
}

function adminKeyMatches(req) {
  const provided = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const expected = Buffer.from(String(ADMIN_KEY));
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function cleanUsername(value) {
  return canonicalUsername(value);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "24mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy",
    "default-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https: http:; " +
    "img-src 'self' blob: data: https: http:; font-src 'self' data: https: http:; connect-src 'self' ws: wss: https: http:; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'self';");
  next();
});
function authenticated(socket) {
  const session=sessions.get(socket.data.authToken);
  return !!session && session.expiresAt>Date.now() && !!accounts[session.username] && session.username===socket.data.username;
}
function broadcastChat(){for(const socket of io.sockets.sockets.values())if(authenticated(socket))socket.emit('lobby-chat',lobbyChat.map(m=>({...m,...accountProfile(m.name),admin:isSuperAdmin(m.name)})));}
function broadcastModeration(){for(const socket of io.sockets.sockets.values())if(authenticated(socket))socket.emit('moderation-state',{muted:lobbyMutes,banned:globalBans});}

function authorizeRequest(req){
  if(adminKeyMatches(req))return {admin:true};
  const session=sessions.get(String(req.headers.authorization||'').replace(/^Bearer /,''));
  return session&&session.expiresAt>Date.now()&&accounts[session.username]?{username:session.username}:null;
}
function canEnter(username,code){return rooms.has(code)&&[...io.sockets.sockets.values()].some(s=>authenticated(s)&&s.data.username===username&&s.data.roomCode===code);}
installSecure(app,io,authenticated);
app.use((req,res,next)=>{
  if(req.body && typeof req.body.username==='string')req.body.username=canonicalUsername(req.body.username);
  req.url=req.url.replace(/^(\/api\/(?:admin\/accounts|admin\/registrations|profile|avatar)\/)([^/?]+)/,(_,prefix,name)=>prefix+encodeURIComponent(canonicalUsername(decodeURIComponent(name))));
  const session=sessions.get(String(req.headers.authorization||'').replace(/^Bearer /,''));
  const account=session&&session.expiresAt>Date.now()?accounts[session.username]:null;
  const common=['/api/login','/api/bot/login','/api/logout','/api/me','/api/presence'];
  if(account?.blocked&&!['GET','HEAD'].includes(req.method)&&!common.includes(req.path))return res.status(403).json({error:'账号已封禁，仅可浏览'});
  if(account?.type==='bot'&&!common.includes(req.path)&&!req.path.startsWith('/api/program')&&!req.path.startsWith('/api/bot/'))return res.status(403).json({error:'BOT 账号仅可使用工作台'});
  if(globalBans.includes(session?.username)&&req.method!=='GET'&&req.path==='/api/announcements')return res.status(403).json({error:'账号已全站禁言'});
  next();
});
installProfiles(app,{accounts,authorize:authorizeRequest,accountProfile,saveAccounts,rooms,onAvatar:()=>{broadcastChat();for(const room of rooms.values())emitRoom(room);}});
installImages(app,{authorize:authorizeRequest,canEnter,isAdmin:req=>{const user=authorizeRequest(req);return !!user&&(user.admin||isSuperAdmin(user.username));},isMuted:(username,scope)=>{
  if(scope.startsWith('group:'))return (groupData.groups[cleanGroupId(scope.slice(6))]?.muted||[]).includes(username)||globalBans.includes(username);
  return (scope==='lobby'?lobbyMutes:rooms.get(scope)?.chatMuted||[]).includes(username)||globalBans.includes(username);
},canUpload:username=>groupCan(username,'images'),canGroup:(username,id)=>isSuperAdmin(username)||groupForUser(username)?.id===cleanGroupId(id)});
app.post('/api/presence', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now() || !accounts[session.username]) return res.status(401).json({error:'请先登录'});
  presence.set(token, Date.now());
  for (const [key, time] of presence) if (Date.now() - time > 45000 || !sessions.has(key)) presence.delete(key);
  res.json({ok:true});
});
app.get('/api/announcements', (_req, res) => {
  res.json(announcements.map(m => ({...m, ...accountProfile(m.name)})));
});
app.post('/api/announcements', async (req, res) => {
  const user = authorizeRequest(req);
  if (!user || !(user.admin || isSuperAdmin(user.username))) return res.status(403).json({error:'只有管理员可以发布公告'});
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 8000) return res.status(400).json({error:'公告须为 1–8000 字'});
  const message = {id:crypto.randomUUID(), name:user.username || '管理员', text, time:Date.now()};
  announcements.push(message); announcements = announcements.slice(-200);
  await saveLobbyModeration.flush();
  res.json({ok:true});
  for (const socket of io.sockets.sockets.values()) socket.emit('announcements', announcements.map(m => ({...m,...accountProfile(m.name)})));
});
app.delete('/api/announcements/:id', async (req, res) => {
  const user = authorizeRequest(req);
  if (!user || !(user.admin || isSuperAdmin(user.username))) return res.status(403).json({error:'只有管理员可以删除公告'});
  announcements = announcements.filter(m => m.id !== req.params.id);
  await saveLobbyModeration.flush(); res.json({ok:true});
  for (const socket of io.sockets.sockets.values()) socket.emit('announcements', announcements.map(m => ({...m,...accountProfile(m.name)})));
});
app.use(express.static(path.join(__dirname, "../public")));
const requireAdmin = (req, res, next) => {
  const user = authorizeRequest(req);
  if (!user || !(user.admin || isSuperAdmin(user.username))) return res.status(403).json({ error: "需要管理员账号或正确管理密钥" });
  next();
};
app.use("/api/admin", requireAdmin);
app.get('/room/:code', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/contests.html', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/profile/:username', (_req, res) => res.sendFile(path.join(__dirname, '../public/profile.html')));
app.get('/BOT_API.md', (_req, res) => res.sendFile(path.join(__dirname, '../BOT_API.md')));
app.get('/downloads/secure-client.js', (_req, res) => res.download(path.join(__dirname, '../bots/secure-client.js')));
app.get('/api/admin/chat', (req,res) => {
  res.json({messages:lobbyChat,muted:lobbyMutes,banned:globalBans});
});
app.post('/api/admin/chat', (req,res) => {
  const payload = req.body || {};
  let error;
  if (payload.action === 'ban' || payload.action === 'unban') error = changeBan(globalBans, payload, SUPER_RANK);
  else error = changeChat(lobbyChat,lobbyMutes,payload,SUPER_RANK,null);
  if(error)return res.status(400).json({error});
  saveLobbyModeration();broadcastChat();broadcastModeration();res.json({ok:true});
});
app.get('/api/admin/groups', (req,res)=>{
  res.set('Cache-Control','no-store');
  const user=authorizeRequest(req);
  const allowed=adminKeyMatches(req)||(user?.username&&isSuperAdmin(user.username));
  if(!allowed)return res.status(403).json({error:'需要管理员权限'});
  res.json(Object.values(groupData.groups).map(g=>({
    id:g.id,name:g.name,chatPaused:!!g.chatPaused,playPaused:!!g.playPaused,imagesPaused:!!g.imagesPaused,
    dailyRoomLimit:g.dailyRoomLimit??3,keepRoomHistory:!!g.keepRoomHistory
  })));
});
app.get('/api/admin/groups/:id/chat',(req,res)=>{
  const user=authorizeRequest(req);
  if(!adminKeyMatches(req)&&!(user?.username&&isSuperAdmin(user.username)))return res.status(403).json({error:'需要管理员权限'});
  const group=groupData.groups[cleanGroupId(req.params.id)];if(!group)return res.status(404).json({error:'分组不存在'});
  res.set('Cache-Control','no-store').json({messages:group.chat.map(m=>({...m,...accountProfile(m.name)})),muted:group.muted||[],banned:globalBans});
});
app.get('/api/groups', (req,res)=>{
  res.set('Cache-Control','no-store');
  const user=authorizeRequest(req); if(!user?.username)return res.status(401).json({error:'请先登录'});
  const admin=isSuperAdmin(user.username), account=accounts[user.username]; normalizeAccount(account);
  const visible=admin?Object.values(groupData.groups):[groupForUser(user.username)];
  res.json({current:account.groupId,admin,groups:visible.map(g=>({id:g.id,name:g.name,chatPaused:g.chatPaused,playPaused:g.playPaused,imagesPaused:g.imagesPaused,dailyRoomLimit:g.dailyRoomLimit,keepRoomHistory:g.keepRoomHistory,chat:g.chat.map(m=>({...m,...accountProfile(m.name)})),muted:g.muted||[],members:Object.keys(accounts).filter(username=>{normalizeAccount(accounts[username]);return accounts[username].groupId===g.id;}).map(username=>({...accountProfile(username),username}))}))});
});
app.post('/api/groups/:id/chat', async (req,res)=>{
  const user=authorizeRequest(req); if(!user?.username)return res.status(401).json({error:'请先登录'});
  const id=cleanGroupId(req.params.id), group=groupData.groups[id]; if(!group)return res.status(404).json({error:'分组不存在'});
  const admin=isSuperAdmin(user.username), account=accounts[user.username]; normalizeAccount(account);
  if(!admin&&account.groupId!==id)return res.status(403).json({error:'只能查看和使用自己分组的聊天室'});
  if(group.chatPaused&&!admin)return res.status(403).json({error:'该分组聊天已暂停'});
  if(globalBans.includes(user.username))return res.status(403).json({error:'你已被全站禁言'});
  const text=String(req.body?.text||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,8000);if(!text)return res.status(400).json({error:'消息不能为空'});
  if((group.muted||[]).includes(user.username))return res.status(403).json({error:'你已被该分组禁言'});
  group.chat.push({id:crypto.randomUUID(),name:user.username,admin:isSuperAdmin(user.username),text,time:Date.now()});group.chat=group.chat.slice(-100);await saveLobbyModeration.flush();res.json({ok:true});
});

app.post(['/api/groups/:id/chat/action','/api/admin/groups/:id/chat/action'], async (req,res)=>{
  const user=authorizeRequest(req);if(!user?.username&&!adminKeyMatches(req))return res.status(401).json({error:'请先登录'});
  const id=cleanGroupId(req.params.id),group=groupData.groups[id];if(!group)return res.status(404).json({error:'分组不存在'});
  if(user?.username)normalizeAccount(accounts[user.username]);const admin=adminKeyMatches(req)||isSuperAdmin(user?.username);
  if(!admin&&accounts[user.username].groupId!==id)return res.status(403).json({error:'只能管理自己分组的消息'});
  const action=String(req.body?.action||'');if(!user?.username&&(action==='recall'||action==='react'))return res.status(403).json({error:'请登录账号'});const message=group.chat.find(m=>m.id===req.body?.messageId);
  if(action==='recall'){
    if(!message||message.recalled)return res.status(404).json({error:'消息不存在'});
    if(message.name!==user.username)return res.status(403).json({error:'只能撤回自己的消息'});
    if(Date.now()-message.time>5*60*1000)return res.status(400).json({error:'超过 5 分钟，无法撤回'});
    message.text='[已撤回]';message.recalled=true;delete message.reactions;
  }else if(action==='react'){
    if(!message||message.recalled)return res.status(404).json({error:'消息不存在'});
    if((group.muted||[]).includes(user.username)||globalBans.includes(user.username))return res.status(403).json({error:'你已被禁言'});
    const emoji=String(req.body?.emoji||'');if(!EMOJIS.includes(emoji))return res.status(400).json({error:'不支持的表情'});
    message.reactions ||= {};const users=message.reactions[emoji] ||= [];const k=users.indexOf(user.username);
    if(k>=0)users.splice(k,1);else users.push(user.username);if(!users.length)delete message.reactions[emoji];
  }else if(action==='mute'||action==='unmute'){
    if(!admin)return res.status(403).json({error:'只有管理员可以管理分组禁言'});
    const target=canonicalUsername(req.body?.username);if(!accounts[target])return res.status(404).json({error:'账号不存在'});
    group.muted ||= [];const k=group.muted.indexOf(target);
    if(action==='mute'&&k<0)group.muted.push(target);if(action==='unmute'&&k>=0)group.muted.splice(k,1);
  }else if(action==='ban'||action==='unban'){
    if(!admin)return res.status(403).json({error:'需要管理员权限'});
    const target=canonicalUsername(req.body?.username);if(!accounts[target])return res.status(404).json({error:'账号不存在'});
    if(isSuperAdmin(target))return res.status(403).json({error:'不能操作管理员'});
    const k=globalBans.indexOf(target);if(action==='ban'&&k<0)globalBans.push(target);if(action==='unban'&&k>=0)globalBans.splice(k,1);
  }else if(action==='delete'){
    if(!admin)return res.status(403).json({error:'只有管理员可以删除消息'});
    const ids=new Set(Array.isArray(req.body?.ids)?req.body.ids:[req.body?.messageId]);group.chat=group.chat.filter(m=>!ids.has(m.id));
  }else return res.status(400).json({error:'未知操作'});
  await saveLobbyModeration.flush();res.json({ok:true});
});
app.post('/api/admin/groups', async (req,res)=>{
  const id=cleanGroupId(req.body?.id);const name=String(req.body?.name||'').trim().slice(0,40);if(!id||!name)return res.status(400).json({error:'分组 ID 和名称不能为空'});if(groupData.groups[id])return res.status(409).json({error:'分组已存在'});
  groupData.groups[id]={id,name,chatPaused:false,playPaused:false,imagesPaused:false,dailyRoomLimit:3,keepRoomHistory:false,chat:[],muted:[]};await saveLobbyModeration.flush();res.status(201).json({ok:true});
});
app.patch('/api/admin/groups/:id', async (req,res)=>{
  const id=cleanGroupId(req.params.id),g=groupData.groups[id];if(!g)return res.status(404).json({error:'分组不存在'});
  if(typeof req.body?.name==='string'&&req.body.name.trim())g.name=req.body.name.trim().slice(0,40);
  for(const k of ['chatPaused','playPaused','imagesPaused','keepRoomHistory'])if(typeof req.body?.[k]==='boolean')g[k]=req.body[k];
  if(req.body?.dailyRoomLimit!==undefined){const n=Number(req.body.dailyRoomLimit);if(!Number.isInteger(n)||n<0||n>1000)return res.status(400).json({error:'每日房间上限须为 0–1000'});g.dailyRoomLimit=n;}
  await saveLobbyModeration.flush();res.json({ok:true});
});
app.delete('/api/admin/groups/:id', async (req,res)=>{
  const id=cleanGroupId(req.params.id);if(id==='default')return res.status(400).json({error:'默认分组不能删除'});if(!groupData.groups[id])return res.status(404).json({error:'分组不存在'});
  delete groupData.groups[id];for(const a of Object.values(accounts))if(a.groupId===id)a.groupId='default';await Promise.all([saveLobbyModeration.flush(),saveAccounts.flush()]);res.json({ok:true});
});
app.patch('/api/admin/group-members', async (req,res)=>{
  const usernames=Array.isArray(req.body?.usernames)?[...new Set(req.body.usernames.map(String))]:[];
  const id=cleanGroupId(req.body?.groupId);if(!usernames.length)return res.status(400).json({error:'请选择成员'});if(!groupData.groups[id])return res.status(400).json({error:'分组不存在'});
  let changed=0;for(const username of usernames){const a=accounts[username];if(!a||a.status==='pending'||a.type==='bot')continue;a.groupId=id;changed++;}
  await saveAccounts.flush();res.json({ok:true,changed});
});
app.get('/api/admin/group-members', (_req,res)=>{
  res.set('Cache-Control','no-store');
  res.json(Object.keys(accounts).filter(u=>accounts[u].status!=='pending'&&accounts[u].type!=='bot').sort().map(username=>{const a=accounts[username];normalizeAccount(a);return {username,groupId:a.groupId};}));
});
app.patch('/api/admin/group-members/:username', async (req,res)=>{
  const username=canonicalUsername(req.params.username),a=accounts[username];if(!a)return res.status(404).json({error:'账号不存在'});normalizeAccount(a);
  if(req.body?.groupId!==undefined){const id=cleanGroupId(req.body.groupId);if(!groupData.groups[id])return res.status(400).json({error:'分组不存在'});a.groupId=id;}
  await saveAccounts.flush();res.json({ok:true});
});

app.get('/api/rooms/:code/replay', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user=authorizeRequest(req);
  if(!user)return res.status(403).json({error:'请先登录'});
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: '房间已关闭，棋谱已删除' });
  if (room.phase !== 'finished') return res.status(403).json({ error: '对局结束后才可查看棋谱' });
  if (!room.replay) return res.status(404).json({ error: '本局开始时未启用棋谱记录' });
  res.json({...room.replay,...(user.admin||isSuperAdmin(user.username)||canEnter(user.username,room.code)?{chat:room.chat}:{} )});
});
app.use('/vendor/marked', express.static(path.join(__dirname, '../node_modules/marked/lib')));
app.use('/vendor/dompurify', express.static(path.join(__dirname, '../node_modules/dompurify/dist')));
app.use('/vendor/katex', express.static(path.join(__dirname, '../node_modules/katex/dist')));
app.get('/api/admin/rooms', (req, res) => {
  res.json(roomSummaries().map(summary=>{
    const room=rooms.get(summary.code);
    const {botClock,spectators,privateLogs,...data}=room;
    const stored={...data,privateLogs:[...privateLogs],players:room.players.map(p=>({...p,socketId:null,online:false}))};
    const bytes=Buffer.byteLength(JSON.stringify(stored));
    const chatBytes=Buffer.byteLength(JSON.stringify(room.chat||[]));
    return {...summary,bytes,chatBytes,gameBytes:bytes-chatBytes};
  }));
});
app.post('/api/admin/rooms/:code/finish', async (req,res) => {
  const room=rooms.get(req.params.code);
  if(!room)return res.status(404).json({error:'房间不存在'});
  finishByAdmin(room); await saveRooms.flush(); res.json({ok:true});
});
app.delete('/api/admin/rooms/:code/chat', async (req,res) => {
  const room=rooms.get(req.params.code);
  if(!room)return res.status(404).json({error:'房间不存在'});
  room.chat=[]; emitRoom(room); await saveRooms.flush(); res.json({ok:true});
});
app.delete('/api/admin/rooms/:code', async (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  rooms.delete(room.code);
  botAPI.update(room);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.roomCode !== room.code) continue;
    socket.emit('room-closed'); socket.leave(room.code);
    socket.data.roomCode = null; socket.data.seat = null; socket.data.spectator = false;
  }
  emitLobby();
  await saveRooms.flush();
  res.json({ ok: true });
});
app.get('/downloads/siguo-junqi-bot.mjs', (_req, res) => res.download(path.join(__dirname, '../bots/siguo-junqi-bot.mjs')));
app.get('/downloads/bot-studio-bot.js', (_req, res) => res.download(path.join(__dirname, '../public/bot-studio-bot.js')));
app.get("/health", (_request, response) => response.json({ ok: true, rooms: rooms.size }));
app.get("/api/rooms", (_request, response) => response.json(roomSummaries()));

app.get('/api/profiles', (_req,res) => res.json(Object.keys(accounts).filter(name=>accounts[name].status!=='pending').map(username=>({username,...accountProfile(username)}))));
app.get("/api/ratings", (_request, response) => {
  const ranking = Object.keys(accounts)
    .filter((username) => accounts[username].status !== "pending" && (accounts[username].type === 'bot') === (_request.query.type === 'bot'))
    .map((username) => ({ username, ...accountProfile(username) }))
    .sort((a, b) => b.rating - a.rating || b.ratedGames - a.ratedGames || a.username.localeCompare(b.username, "zh-CN"))
    .map((account, index) => ({ position: index + 1, ...account }));
  response.json(ranking);
});
function login(request, response, accountType) {
  response.set('Cache-Control', 'no-store');
  const username = cleanUsername(request.body?.username);
  const blocked = throttleBlocked(request, username);
  if (blocked) return response.status(429).json({ error: "尝试过于频繁，请稍后再试", retryAfter: blocked.retryAfter });
  const account = accounts[username];
  // Burn the same scrypt cost for unknown users so response timing does not reveal
  // whether a username exists.
  const salt = account?.salt || DUMMY_SALT;
  const hash = passwordHash(request.body?.password, salt).hash;
  const actual = Buffer.from(hash, "hex");
  const expected = account ? Buffer.from(account.hash, "hex") : Buffer.alloc(actual.length);
  const ok = !!account && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!ok) {
    throttleFailAuth(request, username, AUTH_USER_FAIL_LIMIT);
    return response.status(401).json({ error: "账号或密码错误" });
  }
  if (account.status === "pending") return response.status(403).json({ error: "注册申请正在等待管理员审核" });
  if (accountType && account.type !== accountType) return response.status(403).json({ error: "该接口仅供 BOT 账号使用" });
  throttleClearAuth(request, username);
  const token = randomToken();
  sessions.set(token, { username, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  response.json({ token, username, ...accountProfile(username) });
}
app.post("/api/login", (req, res) => login(req, res, null));
app.post("/api/bot/login", (req, res) => login(req, res, "bot"));
app.get("/api/me", (request, response) => {
  const token = String(request.headers.authorization || "").replace(/^Bearer /, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return response.status(401).json({ error: "登录已失效" });
  response.json({ token, username: session.username, ...accountProfile(session.username) });
});
app.post("/api/logout", (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  sessions.delete(token);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.authToken !== token) continue;
    const room = rooms.get(socket.data.roomCode);
    if (room) {
      const player = room.players.find((item) => item.socketId === socket.id);
      const member = room.spectators.get(socket.id);
      const departedName = player?.name || member?.name;
      let removedSeat = null;
      if (room.rated && room.phase === "playing" && player && !player.eliminated) {
        removedSeat = player.seat;
        eliminate(room, player.seat, "退出登录，判定认输");
        player.socketId = null; player.online = false;
        socket.leave(room.code); socket.data.roomCode = null; socket.data.seat = null;
        checkWinner(room);
      } else {
        removedSeat = removeMember(room, socket, "退出了登录", room.phase === "playing");
      }
      if (room.phase === "playing" && removedSeat === room.turn) advanceTurn(room);
      transferHostIfNeeded(room, departedName);
      emitRoom(room);
    }
    socket.disconnect(true);
  }
  emitLobby();
  res.json({ ok: true });
});
app.get("/api/admin/accounts", (request, response) => {
  const names = Object.keys(accounts).filter(name => accounts[name].status !== "pending").sort();
  response.json(request.query.details === "1" ? names.map(username => ({ username, ...accountProfile(username) })) : names);
});
app.get('/api/admin/online', (_req, res) => {
  const users = new Map();
  function add(username, room) {
    if (!accounts[username]) return;
    if (!users.has(username)) users.set(username, {username, ...accountProfile(username), rooms:[]});
    if (room && !users.get(username).rooms.includes(room)) users.get(username).rooms.push(room);
  }
  for (const socket of io.sockets.sockets.values()) if (authenticated(socket)) add(socket.data.username, socket.data.roomCode);
  for (const [token, time] of presence) {
    const session = sessions.get(token);
    if (session?.expiresAt > Date.now() && Date.now() - time < 45000) add(session.username);
  }
  for (const username of Object.keys(accounts)) if (accounts[username].type === 'bot' && botAPI.isOnline(username)) {
    add(username);
    for (const room of rooms.values()) if (room.players.some(p => p.username === username)) add(username, room.code);
  }
  res.json([...users.values()].sort((a,b)=>a.username.localeCompare(b.username, 'zh-CN')));
});
app.post("/api/admin/accounts", async (request, response) => {
  const username = cleanUsername(request.body?.username);
  const password = String(request.body?.password || "");
  const requestedType = request.body?.accountType || "human";
  if (!["human", "bot", "admin"].includes(requestedType)) return response.status(400).json({ error: "账号类型无效" });
  const type = requestedType === "admin" ? "human" : requestedType;
  const admin = requestedType === "admin";
  if(admin && !adminKeyMatches(request))return response.status(403).json({error:'创建管理员需要管理密钥'});
  if (!validCredentials(username, password)) return response.status(400).json({ error: "账号须为 2–16 位中文、字母、数字或下划线；密码须为 6–64 位" });
  if (accounts[username]) return response.status(409).json({ error: "账号已存在" });
  accounts[username] = { ...passwordHash(password), type, admin, rating: INITIAL_RATING, ratedGames: 0, peakRating: INITIAL_RATING, groupId:'default', roomCreateDay:'', roomCreateCount:0 };
  await saveAccounts.flush();
  response.status(201).json({ username });
});

app.patch("/api/admin/accounts/:username/admin", async (request, response) => {
  if(!adminKeyMatches(request))return response.status(403).json({error:'修改管理员权限需要管理密钥'});
  const username = request.params.username;
  if (!accounts[username]) return response.status(404).json({ error: "账号不存在" });
  if (typeof request.body?.admin !== 'boolean') return response.status(400).json({ error: "admin 必须为布尔值" });
  if (accounts[username].type !== 'human') return response.status(400).json({ error: "只有玩家账号可设为管理员" });
  normalizeAccount(accounts[username]);
  const previousAdmin=accounts[username].admin;
  accounts[username].admin = request.body.admin;
  try{await saveAccounts.flush();}catch(error){accounts[username].admin=previousAdmin;throw error;}
  for(const socket of io.sockets.sockets.values())if(authenticated(socket)&&socket.data.username===username)socket.emit('account-profile',accountProfile(username));
  for(const room of rooms.values()){
    for(const member of room.spectators.values())if(member.username===username)member.revealAll=false;
    emitRoom(room);
  }
  broadcastChat();broadcastModeration();
  response.json({ username, ...accountProfile(username) });
});

app.patch('/api/admin/accounts/:username/block',async(req,res)=>{
  const username=canonicalUsername(req.params.username),account=accounts[username];
  if(!account)return res.status(404).json({error:'账号不存在'});
  if(typeof req.body?.blocked!=='boolean')return res.status(400).json({error:'参数无效'});
  if(account.admin&&!adminKeyMatches(req))return res.status(403).json({error:'封禁管理员需要管理密钥'});
  const previous=account.blocked;account.blocked=req.body.blocked;
  try{await saveAccounts.flush();}catch(error){account.blocked=previous;throw error;}
  if(account.blocked)for(const room of rooms.values()){
    if(room.phase!=='playing'||!room.players.some(p=>p.username===username&&!p.eliminated))continue;
    const wasTurn=room.players.some(p=>p.username===username&&p.seat===room.turn);
    for(const player of room.players)if(player.username===username&&!player.eliminated)eliminate(room,player.seat,'账号已封禁，判负');
    checkWinner(room);if(wasTurn)advanceTurn(room);emitRoom(room);
  }
  for(const socket of io.sockets.sockets.values())if(socket.data.username===username)socket.emit('account-profile',{username,...accountProfile(username)});
  res.json({username,...accountProfile(username)});
});
app.patch("/api/admin/accounts/:username/rating", async (request, response) => {
  const username = request.params.username;
  const rating = Number(request.body?.rating);
  if (!accounts[username]) return response.status(404).json({ error: "账号不存在" });
  if (!Number.isInteger(rating) || rating < -100 || rating > 8000) return response.status(400).json({ error: "Rating 必须是 -100～8000 的整数" });
  normalizeAccount(accounts[username]);
  const before=accounts[username].rating;
  if(before!==rating)accounts[username].ratingHistory.push({time:Date.now(),name:'管理员调整',kind:'adjustment',before,after:rating,delta:rating-before,pool:accounts[username].type});
  accounts[username].rating = rating;
  accounts[username].peakRating = Math.max(accounts[username].peakRating, rating);
  await saveAccounts.flush();
  response.json({ username, ...accountProfile(username) });
  for (const socket of io.sockets.sockets.values()) if (authenticated(socket) && socket.data.username === username) socket.emit('account-profile', accountProfile(username));
  for (const room of rooms.values()) emitRoom(room);
  broadcastChat();
});

app.delete("/api/admin/accounts/:username", async (request, response) => {
  const username = request.params.username;
  if (!Object.hasOwn(accounts, username)) return response.status(404).json({ error: "账号不存在" });
  const account = accounts[username];
  if(account.admin&&!adminKeyMatches(request))return response.status(403).json({error:'删除管理员需要管理密钥'});
  for(const room of rooms.values())if(room.phase==='playing'&&room.rated&&room.players.some(p=>p.username===username))finishByAdmin(room);
  delete accounts[username];
  try { await saveAccounts.flush(); }
  catch { accounts[username] = account; return response.status(500).json({ error: "删除失败，请重试" }); }
  for (const [token, session] of sessions) {
    if (session.username === username) sessions.delete(token);
  }
  botAPI.removeAccount(username);
  await hosted.remove(username);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.username === username) {
      socket.emit("account-deleted");
      socket.disconnect(true);
    }
  }
  response.json({ username });
});

function validCredentials(username, password) {
  return typeof username === "string" && /^[A-Za-z0-9_\u4e00-\u9fff]{2,16}$/.test(username)
    && typeof password === "string" && password.length >= 6 && password.length <= 64;
}
app.post("/api/register", async (req, res) => {
  const blocked = throttleBlocked(req, "register");
  if (blocked) return res.status(429).json({ error: "注册过于频繁，请稍后再试", retryAfter: blocked.retryAfter });
  const { username, password } = req.body || {};
  const type = req.body?.accountType || "human";
  if (!["human", "bot"].includes(type)) { throttleFailAuth(req, "register", AUTH_USER_FAIL_LIMIT); return res.status(400).json({ error: "账号类型无效" }); }
  if (!validCredentials(username, password)) { throttleFailAuth(req, "register", AUTH_USER_FAIL_LIMIT); return res.status(400).json({ error: "账号须为 2–16 位中文、字母、数字或下划线；密码须为 6–64 位" }); }
  if (Object.hasOwn(accounts, username)) { throttleFailAuth(req, "register", AUTH_USER_FAIL_LIMIT); return res.status(409).json({ error: "账号已存在或正在审核" }); }
  accounts[username] = { ...passwordHash(password), type, status: "pending", createdAt: Date.now(), rating: INITIAL_RATING, ratedGames: 0, peakRating: INITIAL_RATING, groupId:'default', roomCreateDay:'', roomCreateCount:0 };
  try { await saveAccounts.flush(); } catch { delete accounts[username]; return res.status(500).json({ error: "保存失败，请重试" }); }
  throttleClearAuth(req, "register");
  res.status(201).json({ message: "申请已提交，管理员通过后即可登录" });
});
app.get("/api/admin/registrations", (req, res) => {
  res.json(Object.entries(accounts).filter(([, a]) => a.status === "pending").map(([username, a]) => ({ username, accountType: a.type, createdAt: a.createdAt })));
});
app.post("/api/admin/registrations/:username", async (req, res) => {
  const username = req.params.username, previous = accounts[username];
  if (!previous || previous.status !== "pending") return res.status(404).json({ error: "申请不存在或已处理" });
  if (!["approve", "reject"].includes(req.body?.action)) return res.status(400).json({ error: "审核操作无效" });
  if (req.body.action === "approve") accounts[username] = { ...previous, status: "active" };
  else delete accounts[username];
  try { await saveAccounts.flush(); } catch { accounts[username] = previous; return res.status(500).json({ error: "保存失败，请重试" }); }
  res.json({ username });
});
app.post("/api/password", async (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return res.status(401).json({ error: "请重新登录" });
  const blocked = throttleBlocked(req, session.username);
  if (blocked) return res.status(429).json({ error: "尝试过于频繁，请稍后再试", retryAfter: blocked.retryAfter });
  const previous = accounts[session.username];
  const { oldPassword, password } = req.body || {};
  if (!previous || previous.status === "pending") return res.status(401).json({ error: "请重新登录" });
  if (typeof password !== 'string' || password.length < 6 || password.length > 64 || typeof oldPassword !== "string" || oldPassword.length > 64) return res.status(400).json({ error: "密码须为 6–64 位" });
  if (!crypto.timingSafeEqual(Buffer.from(passwordHash(oldPassword, previous.salt).hash, "hex"), Buffer.from(previous.hash, "hex"))) {
    throttleFailAuth(req, session.username, AUTH_USER_FAIL_LIMIT);
    return res.status(403).json({ error: "原密码错误" });
  }
  accounts[session.username] = { ...previous, ...passwordHash(password) };
  try { await saveAccounts.flush(); } catch { accounts[session.username] = previous; return res.status(500).json({ error: "保存失败，请重试" }); }
  throttleClearAuth(req, session.username);
  for (const [key, value] of sessions) if (value.username === session.username) sessions.delete(key);
  for (const socket of io.sockets.sockets.values()) if (socket.data.username === session.username) { socket.emit("account-deleted"); socket.disconnect(true); }
  res.json({ message: "密码已修改，请使用新密码重新登录" });
});

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let code = "";
    const bytes = crypto.randomBytes(6);
    for (const byte of bytes) code += alphabet[byte % alphabet.length];
    if (!rooms.has(code)) return code;
  }
}

function randomToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function cleanName(value) {
  return String(value || "玩家").replace(/[\u0000-\u001f<>]/g, "").trim() || "玩家";
}

function roomSummaries() {
  return [...rooms.values()].map((room) => ({
    code: room.code,
    name: room.name || room.code,
    capacity: room.capacity,
    players: room.players.length,
    spectators: room.spectators.size,
    mode: room.mode,
    bots: room.players.filter(p => p.isBot).length,
    rated: !!room.rated && !room.aborted && !room.drawn,
    phase: room.phase,
    createdAt: room.createdAt,
    finishedAt: room.finishedAt || null,
    ratingPool: room.ratingPool || null,
    winner: room.winner || null,
  })).sort((a, b) => b.createdAt - a.createdAt);
}

function emitLobby() {
  saveRooms();
  io.emit("room-list", roomSummaries());
}

function authSocket(socket, payload, allowBot = false) {
  const token = String(payload?.authToken || "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  if (accounts[session.username]?.type !== "human" && !(allowBot && accounts[session.username]?.type === 'bot')) return null;
  if(socket.data.roomCode && socket.data.username!==session.username)return null;
  socket.data.authToken = token;
  socket.data.username = session.username;
  return session.username;
}

function addLog(room, text, tone = "normal") {
  if (room.replay) room.replay.logs.push({ time: Date.now(), text, tone });
  room.logs.unshift({ id: `${Date.now()}-${Math.random()}`, time: Date.now(), text, tone });
}

function makePlayer(seat, name, socket) {
  return {
    seat,
    username: cleanUsername(name),
    name: cleanName(name),
    token: randomToken(),
    socketId: socket.id,
    online: true,
    ready: false,
    eliminated: false,
  };
}

function playerForSocket(socket) {
  const code = socket.data.roomCode;
  const room = rooms.get(code);
  if (!room) return {};
  const player = room.players.find((item) => item.socketId === socket.id);
  return { room, player };
}

function isPureBotRoom(room) {
  return room.players.length === room.capacity && room.players.every((player) => player.isBot);
}

function serializeRoom(room, viewer) {
  const viewerIsAdmin = isSuperAdmin(viewer?.username);
  const spectator = !viewer?.seat;
  const adminReveal = viewerIsAdmin && spectator && viewer?.revealAll === true;
  const revealAll = room.phase === "finished" || adminReveal;
  const botDebug = spectator && room.botDebugEnabled === true && isPureBotRoom(room);
  const allTrails=Object.values(room.moveTrails||{}).filter(Boolean).sort((a,b)=>a.ply-b.ply);
  const ownTrail=viewer?.seat ? room.moveTrails?.[viewer.seat] : null;
  const ownIsLatest=ownTrail && ownTrail.ply===room.lastMove?.ply;
  const moveTrails=(ownTrail ? allTrails.filter(move=>move.ply>(ownIsLatest?ownTrail.ply-1:ownTrail.ply)) : allTrails).map(move=>({...move}));
  return {
    code: room.code,
    name: room.name || room.code,
    capacity: room.capacity,
    mode: room.mode,
    chatMuted: room.chatMuted || [],
    rated: !!room.rated && !room.aborted && !room.drawn,
    phase: room.phase,
    turn: room.turn,
    ply: room.ply || 0,
    winner: room.winner,
    hostSeat: room.players.find((p) => p.name === room.hostName)?.seat || null,
    hostName: room.hostName,
    viewerName: viewer?.name || null,
    viewerSeat: viewer?.seat || null,
    viewerIsAdmin,
    canUndo: canUndo(room, viewer),
    drawOffer: room.drawOffer ? {...room.drawOffer, required:room.players.filter(p=>!p.eliminated&&room.pieces.some(piece=>piece.owner===p.seat&&piece.position)).length} : null,
    drawn: !!room.drawn,
    aborted: !!room.aborted,
    layouts: viewer?.username ? (accounts[viewer.username]?.layouts || []).map(({name}, index) => ({name, index})) : [],
    adminRevealEnabled: adminReveal,
    canToggleAdminReveal: viewerIsAdmin && spectator,
    spectator,
    activeSeats: room.activeSeats,
    lastMove: room.lastMove || null,
    moveTrails,
    ratingChanges: room.ratingChanges || null,
    botDebugEnabled: botDebug,
    canToggleBotDebug: (viewer?.name === room.hostName || viewerIsAdmin) && isPureBotRoom(room),
    players: room.activeSeats.map((seat) => {
      const player = room.players.find((item) => item.seat === seat);
      return player ? {
        seat,
        name: player.name,
        ...accountProfile(player.username || player.name),
        isBot: !!player.isBot,
        online: player.isBot ? botAPI.isOnline(player.username) : player.online,
        ready: player.ready,
        eliminated: player.eliminated,
        isHost: room.hostName === player.name,
      } : { seat, empty: true };
    }),
    pieces: room.pieces.filter((piece) => piece.position).map((piece) => ({
      id: piece.id,
      owner: piece.owner,
      position: piece.position,
      type: (botDebug || adminReveal || (!spectator && (revealAll || piece.owner === viewer?.seat || piece.revealed))) ? piece.type : null,
      revealed: piece.revealed,
    })),
    spectators: [...room.spectators.entries()].map(([memberId,member]) => ({ memberId,name: member.name, ...accountProfile(member.username || member.name), isHost: member.name === room.hostName })),
    isHost: viewer?.name === room.hostName,
    isRoomManager: (viewer?.name === room.hostName) || viewerIsAdmin,
    botAccounts: (viewer?.name === room.hostName || viewerIsAdmin) ? botAPI.directory() : [],
    logs: spectator ? room.logs : [...(room.privateLogs.get(viewer.seat) || []), ...room.logs]
      .sort((a, b) => b.time - a.time).slice(0, 80),
    chat: room.chat.map(m=>({...m,...accountProfile(m.name),admin:isSuperAdmin(m.name)})),
  };
}

function emitRoom(room) {
  if(room.drawOffer&&room.drawOffer.roster!==rosterSignature(room))room.drawOffer=null;
  transferHostIfNeeded(room);
  // Adjudicate at the start of a player's turn, equally for humans and bots.
  for (let i = 0; i < room.activeSeats.length && room.phase === "playing"; i++) {
    const current = room.players.find(p => p.seat === room.turn && !p.eliminated);
    if (!current || hasLegalMove(room, current.seat)) break;
    eliminate(room, current.seat, "无合法着法，困毙判负");
    checkWinner(room);
    advanceTurn(room);
  }
  botAPI.update(room);
  if (room.replay && !room.replay.completed) {
    const frame = { pieces: room.pieces, turn: room.turn, phase: room.phase, lastMove: room.lastMove, players: room.players.map(p => ({ name: p.name, seat: p.seat, eliminated: p.eliminated })) };
    const previous = room.replay.frames.at(-1);
    if (!previous || JSON.stringify(frame) !== JSON.stringify(previous.state)) {
      room.replay.frames.push({ time: Date.now(), state: structuredClone(frame) });
    }
    room.replay.winner = room.winner;
    if(room.phase==='finished'){room.replay.completed=true;room.replay.finishedAt=room.finishedAt;room.replay.ratingChanges=room.ratingChanges;}
  }
  for (const player of room.players) {
    if (!player.socketId) continue;
    io.sockets.sockets.get(player.socketId)?.emit("room-state", serializeRoom(room, player));
  }
  for (const [socketId, member] of room.spectators) io.sockets.sockets.get(socketId)?.emit("room-state", serializeRoom(room, member));
  emitLobby();
}

function replyError(socket, message) {
  socket.emit("game-error", message);
}

function joinSocket(socket, room, player) {
  if (player.socketId && player.socketId !== socket.id) {
    io.sockets.sockets.get(player.socketId)?.emit("session-replaced");
    io.sockets.sockets.get(player.socketId)?.disconnect(true);
  }
  player.socketId = socket.id;
  player.online = true;
  socket.data.roomCode = room.code;
  socket.data.seat = player.seat;
  socket.join(room.code);
  room.spectators.delete(socket.id);
  socket.data.spectator = false;
  socket.emit("session", { code: room.code, token: player.token, seat: player.seat });
  addLog(room, `${player.name} 已连接`);
  socket.emit("board-meta", publicBoard());
  emitRoom(room);
}

function addPrivateLog(room, seat, text, tone = "battle") {
  const list = room.privateLogs.get(seat) || [];
  list.unshift({ id: `${Date.now()}-${Math.random()}`, time: Date.now(), text, tone, private: true });
  room.privateLogs.set(seat, list);
}

function eliminate(room, seat, reason) {
  room.drawOffer=null;
  const player = room.players.find((item) => item.seat === seat);
  if (player?.eliminated) return;
  if(room.pieces.some(p=>p.owner===seat&&p.position))room.noCapturePly=0;
  if (player) player.eliminated = true;
  if (!room.eliminationOrder.includes(seat)) room.eliminationOrder.push(seat);
  for (const piece of room.pieces) {
    if (piece.owner === seat) piece.position = null;
  }
  addLog(room, `${SEAT_NAMES[seat]}${reason}`, "danger");
}

function livingSeats(room) {
  // An unoccupied direction retains its army and may be taken over by a BOT.
  return room.activeSeats.filter(seat => room.pieces.some(p => p.owner === seat && p.position));
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

function settleRatings(room) {
  if (!room.rated || room.ratingSettled || room.aborted || room.drawn || !room.ratedParticipants?.length) return;
  room.ratingSettled = true;
  const participants = room.ratedParticipants;
  const k = 256; // Equal-rated win/loss: approximately +128 / -128.
  let raw;
  if (room.mode === "alliance") {
    const ns = participants.filter((item) => item.seat === "north" || item.seat === "south");
    const ew = participants.filter((item) => item.seat === "east" || item.seat === "west");
    const nsRating = ns.reduce((sum, item) => sum + item.rating, 0) / ns.length;
    const ewRating = ew.reduce((sum, item) => sum + item.rating, 0) / ew.length;
    const nsScore = room.winner === "南北联盟" ? 1 : 0;
    const magnitude = Math.max(1, Math.round(Math.abs(k * (nsScore - expectedScore(nsRating, ewRating)))));
    const change = nsScore ? magnitude : -magnitude;
    raw = participants.map((item) => (['north','south'].includes(item.seat) ? change : -change));
  } else {
    const rank = new Map(participants.map((item) => {
      const eliminatedAt = room.eliminationOrder.indexOf(item.seat);
      return [item.seat, eliminatedAt < 0 ? 1 : participants.length - eliminatedAt];
    }));
    raw = participants.map((item) => {
      let value = 0;
      for (const other of participants) {
        if (other === item) continue;
        const score = rank.get(item.seat) < rank.get(other.seat) ? 1 : rank.get(item.seat) === rank.get(other.seat) ? 0.5 : 0;
        value += score - expectedScore(item.rating, other.rating);
      }
      return k * value / (participants.length - 1);
    });
  }
  const average = raw.reduce((sum, value) => sum + value, 0) / raw.length;
  const deltas = raw.map((value) => Math.round(value - average));
  deltas[0] -= deltas.reduce((sum, value) => sum + value, 0);
  room.ratingChanges = {};
  const grouped = new Map();
  participants.forEach((item,index)=>{const group=grouped.get(item.username)||[];group.push({item,delta:deltas[index]});grouped.set(item.username,group);});
  for (const [username, entries] of grouped) {
    const account = accounts[username];
    if (!account) continue;
    normalizeAccount(account);
    const before = account.rating;
    account.rating = Math.max(-100, Math.min(8000,account.rating + Math.round(entries.reduce((n,e)=>n+e.delta,0)/entries.length)));
    account.ratedGames += 1;
    account.peakRating = Math.max(account.peakRating, account.rating);
    account.ratingHistory.push({time:Date.now(),code:room.code,name:room.name||room.code,before,after:account.rating,delta:account.rating-before,pool:room.ratingPool||'human'});
    for(const {item} of entries) room.ratingChanges[item.seat] = { before, delta: account.rating - before, after: account.rating, ...accountProfile(username) };
  }
  saveAccounts();
  addLog(room, "排位分已结算", "success");
}

function finishByAdmin(room) {
  if(room.phase==='finished')return;
  room.aborted=true; room.phase='finished'; room.finishedAt=Date.now(); room.turn=null; room.undo=null; room.drawOffer=null;
  room.winner='管理员结束（不计分）';
  addLog(room,'管理员结束比赛，本局不结算 Rating'); emitRoom(room);
}

function voteDraw(room,player,accept,offerId) {
  if(room.phase!=='playing'||!room.players.includes(player)||player.eliminated)return '只有存活参赛者可在对局中申请和棋';
  if(typeof accept!=='boolean')return 'accept 必须是布尔值';
  if(!room.drawOffer){
    if(!accept||offerId)return '和棋申请已经失效';
    if(room.players.length!==room.capacity)return '所有参赛位置有人后才能申请和棋';
    room.drawOffer={id:crypto.randomUUID(),proposer:player.seat,accepted:[],time:Date.now(),roster:rosterSignature(room)};
    addLog(room,`${player.name} 申请和棋`);
  }else if(offerId!==room.drawOffer.id)return '和棋申请已经变化，请刷新后表态';
  if(!accept){room.drawOffer=null;addLog(room,`${player.name} 拒绝和棋`);emitRoom(room);return null;}
  if(player.eliminated)return '已阵亡玩家不参与和棋表决';
  if(!room.drawOffer.accepted.includes(player.seat))room.drawOffer.accepted.push(player.seat);
  const living=room.players.filter(p=>!p.eliminated&&room.pieces.some(piece=>piece.owner===p.seat&&piece.position));
  room.drawOffer.accepted=room.drawOffer.accepted.filter(seat=>living.some(p=>p.seat===seat));
  if(living.length&&living.every(p=>room.drawOffer.accepted.includes(p.seat))){
    room.drawOffer=null;room.drawn=true;room.phase='finished';room.finishedAt=Date.now();room.turn=null;room.undo=null;room.winner='和棋';
    addLog(room,'所有仍存活的参赛者同意和棋，本局不结算 Rating');
  }
  emitRoom(room);return null;
}

function checkWinner(room) {
  if(room.phase!=='playing')return;
  const living = livingSeats(room);
  if (room.mode === "alliance") {
    const northSouth = living.filter((seat) => seat === "north" || seat === "south");
    const eastWest = living.filter((seat) => seat === "east" || seat === "west");
    if (!northSouth.length || !eastWest.length) {
      room.phase = "finished";
      room.winner = northSouth.length ? "南北联盟" : "东西联盟";
    }
  } else if (living.length <= 1) {
    room.phase = "finished";
    room.winner = living.length ? SEAT_NAMES[living[0]] : "无人";
  }
  if (room.phase === "finished" && !room.finishedAt) {
    room.finishedAt = Date.now();
    addLog(room, `${room.winner}获胜`, "success");
    settleRatings(room);
  }
}

function advanceTurn(room) {
  if (room.phase !== "playing") return;
  const currentIndex = room.activeSeats.indexOf(room.turn);
  for (let offset = 1; offset <= room.activeSeats.length; offset += 1) {
    const seat = room.activeSeats[(currentIndex + offset) % room.activeSeats.length];
    const player = room.players.find((item) => item.seat === seat);
    if (player && !player.eliminated) {
      room.turn = seat;
      return;
    }
  }
}

function enterRoom(socket, room, username) {
  socket.data.roomCode = room.code;
  socket.data.spectator = true;
  socket.data.seat = null;
  socket.join(room.code);
  room.spectators.set(socket.id, { username: cleanUsername(username), name: cleanName(username), socketId: socket.id });
  socket.emit("session", { code: room.code, token: null, seat: null });
  socket.emit("board-meta", publicBoard());
  addLog(room, `${cleanName(username)} 进入了房间`);
  emitRoom(room);
}

function resumeExistingMember(socket, room, username) {
  const name = cleanName(username);
  const player = room.players.find((item) => !item.isBot && (item.username || item.name) === username);
  if (player) {
    joinSocket(socket, room, player);
    return true;
  }
  const spectator = [...room.spectators.entries()].find(([, item]) => (item.username || item.name) === username);
  if (!spectator) return false;
  const [oldSocketId] = spectator;
  if (oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    oldSocket?.emit("session-replaced");
    room.spectators.delete(oldSocketId);
    oldSocket?.disconnect(true);
  }
  enterRoom(socket, room, name);
  return true;
}

function isHost(room, socket) {
  return room && socket.data.roomCode === room.code &&
    accounts[socket.data.username]?.type === 'human' &&
    cleanName(socket.data.username) === room.hostName;
}
function isRoomManager(room, socket) {
  return isHost(room, socket) || (room && socket.data.roomCode === room.code && isSuperAdmin(socket.data.username));
}

function removeMember(room, socket, reason = "离开了房间", preserveArmy = false) {
  const player = room.players.find((item) => item.socketId === socket.id);
  const removedSeat = player?.seat || null;
  if (player) {
    room.drawOffer=null;
    if(room.phase==='finished'){player.socketId=null;player.online=false;}
    else room.players = room.players.filter((item) => item !== player);
    if (!preserveArmy && room.phase!=='finished') {
      room.pieces = room.pieces.filter((piece) => piece.owner !== player.seat);
      room.privateLogs.delete(player.seat);
    }
    addLog(room, `${player.name} ${reason}`);
  } else {
    const member = room.spectators.get(socket.id);
    if (member) addLog(room, `${member.name} ${reason}`);
    room.spectators.delete(socket.id);
  }
  socket.leave(room.code);
  socket.data.roomCode = null;
  socket.data.seat = null;
  socket.data.spectator = false;
  return removedSeat;
}

function transferHostIfNeeded(room, departedName) {
  if(room.phase==='finished')return;
  const humans = [...room.players, ...room.spectators.values()].filter(item =>
    !item.isBot && item.name !== departedName &&
    accounts[item.username || item.name]?.type === 'human');
  if (humans.some(item => item.name === room.hostName)) return;
  room.hostName = humans.find(item => item.socketId)?.name || humans[0]?.name || null;
  if (room.hostName) addLog(room, `${room.hostName} 成为房主`);
}

function replayPath(room, from, to) {
  if (BOARD.neighbors.get(from).includes(to)) return [from, to];
  const available = id => (!BOARD.byId.get(id).seat || room.activeSeats.includes(BOARD.byId.get(id).seat)) && (id === to || !pieceAt(room.pieces, id));
  for (const line of BOARD.straightRailLines) {
    const a = line.indexOf(from), b = line.indexOf(to);
    if (a < 0 || b < 0) continue;
    const route = line.slice(Math.min(a, b), Math.max(a, b) + 1);
    if (a > b) route.reverse();
    if (route.slice(1).every(available)) return route;
  }
  const queue = [[from]], seen = new Set([from]);
  for (let i = 0; i < queue.length; i++) {
    const route = queue[i];
    for (const next of BOARD.railNeighbors.get(route.at(-1)) || []) {
      if (seen.has(next) || !available(next)) continue;
      const extended = [...route, next];
      if (next === to) return extended;
      seen.add(next); queue.push(extended);
    }
  }
  return [from, to];
}
const UNDO_FIELDS = ['pieces', 'turn', 'ply', 'lastMove', 'moveTrails', 'eliminationOrder', 'logs', 'publicBattles', 'replay', 'noCapturePly'];
function rosterSignature(room) { return JSON.stringify(room.players.map(p => [p.seat, p.username, p.name])); }
function undoBoardSignature(room) { return JSON.stringify([room.pieces, room.turn, room.eliminationOrder, room.players.map(p => !!p.eliminated)]); }
function undoHasCasualty(room) {
  if(!Array.isArray(room.undo?.state?.pieces))return true;
  const alive=new Set(room.pieces.filter(p=>p.position!=null).map(p=>p.id));
  return room.undo.state.pieces.some(p=>p.position!=null&&!alive.has(p.id));
}
function canUndo(room, viewer) {
  return !!(room.undo && !undoHasCasualty(room) && room.phase === 'playing' && viewer?.seat === room.undo.seat && viewer?.username === room.undo.username &&
    room.ply === room.undo.ply && rosterSignature(room) === room.undo.roster && undoBoardSignature(room) === room.undo.after);
}
function applyMove(room, player, from, to) {
    const result = validateMove(room, player.seat, from, to);
    if (!result.ok) return result;

    room.drawOffer=null;

    room.undo = { username: player.username, seat: player.seat, ply: (room.ply || 0) + 1,
      roster: rosterSignature(room),
      state: structuredClone(Object.fromEntries(UNDO_FIELDS.map(key => [key, room[key] ?? (key === 'ply' ? 0 : null)]))),
      privateLogs: structuredClone([...room.privateLogs]),
      eliminated: room.players.map(p => [p.seat, !!p.eliminated]) };
    const { attacker, defender, engineerTurn } = result;
    const route = replayPath(room, from, to);
    attacker.moved = true;
    if (engineerTurn) attacker.revealed = true;
    const outcome = resolveBattle(attacker, defender);
    if (room.replay) room.replay.logs.push({ time: Date.now(), kind: 'move', seat: player.seat, username: player.username, from, to,
      attacker: { id: attacker.id, type: attacker.type }, defender: defender ? { id: defender.id, type: defender.type, owner: defender.owner } : null,
      outcome, engineerTurn, path: route });
    if (defender) {
      room.publicBattles ||= [];
      room.publicBattles.push({ attacker: attacker.id, defender: defender.id, outcome });
    }
    room.ply = (room.ply || 0) + 1;
    room.lastMove = { from, to, path: route, pieceId: outcome === "defender" || outcome === "both" ? null : attacker.id, seat: player.seat, ply: room.ply };
    room.moveTrails ||= {};
    room.moveTrails[player.seat] = {...room.lastMove};
    let message = `${SEAT_NAMES[attacker.owner]}移动了一枚棋子`;
    if (outcome === "move") {
      attacker.position = to;
    } else if (outcome === "attacker") {
      revealFlagWhenCommanderDies(room, defender);
      defender.position = null;
      attacker.position = to;
      message = `${SEAT_NAMES[attacker.owner]}进攻${SEAT_NAMES[defender.owner]}，守方棋子被消灭`;
    } else if (outcome === "defender") {
      revealFlagWhenCommanderDies(room, attacker);
      attacker.position = null;
      message = `${SEAT_NAMES[attacker.owner]}进攻${SEAT_NAMES[defender.owner]}，进攻棋子被消灭`;
    } else {
      revealFlagWhenCommanderDies(room, attacker);
      revealFlagWhenCommanderDies(room, defender);
      attacker.position = null;
      defender.position = null;
      message = `${SEAT_NAMES[attacker.owner]}与${SEAT_NAMES[defender.owner]}交战，双方棋子同时阵亡`;
    }
    if (defender?.type === "flag" && !defender.position) eliminate(room, defender.owner, "军旗被夺，退出对局");
    const attackerName = PIECE_INFO[attacker.type].name;
    const defenderName = defender ? PIECE_INFO[defender.type].name : null;
    addPrivateLog(room, attacker.owner, defender
      ? `你的${attackerName}发起进攻：${outcome === "attacker" ? "胜" : outcome === "defender" ? "阵亡" : "同归于尽"}`
      : `你的${attackerName}从 ${from} 移动到 ${to}`);
    if (defender) addPrivateLog(room, defender.owner,
      `你的${defenderName}遭到进攻：${outcome === "defender" ? "守住" : outcome === "attacker" ? "阵亡" : "同归于尽"}`);
    addLog(room, message, outcome === "move" ? "normal" : "battle");
    if (engineerTurn) addLog(room, `${SEAT_NAMES[attacker.owner]}棋子在铁路转弯，确认为工兵`, "battle");
    recordBotActivity(room,!!defender);
    checkWinner(room);
    const drawReason=autoDrawReason(room);
    if(drawReason){
      room.drawn=true;room.autoDrawReason=drawReason;room.phase='finished';room.finishedAt=Date.now();
      room.turn=null;room.undo=null;room.drawOffer=null;room.winner='和棋';
      addLog(room,`${drawReason==='no-capture'?'连续 16 步无棋子阵亡':`总步数达到 ${room.initialPlayerCount*128}`}，自动和棋，本局不结算 Rating`);
    }
    advanceTurn(room);
    if(room.undo&&undoHasCasualty(room))room.undo=null;
    if(room.undo)room.undo.after = undoBoardSignature(room);
    emitRoom(room);
    return { ok: true };
}

const hosted = installHostedBots({ app, accounts, sessions, server,
  filename: process.env.SIGUO_PROGRAMS_FILE || path.join(path.dirname(ACCOUNTS_FILE), 'bot-programs.json') });
const botAPI = installBotApi({ app, rooms, accounts, sessions, emitRoom, addLog, applyMove, eliminate, checkWinner, advanceTurn, voteDraw,
  isHosted: (username, assignmentId) => hosted.hosted(username, assignmentId) });

io.on("connection", (socket) => {
  socket.use((packet,next)=>{
    const [event,payload]=packet;
    if(payload&&typeof payload==='object'&&typeof payload.username==='string')payload.username=canonicalUsername(payload.username);
    const session=sessions.get(['lobby-auth','create-room','join-room','watch-room'].includes(event)?payload?.authToken:socket.data.authToken);
    const account=session&&session.expiresAt>Date.now()?accounts[session.username]:null;
    let error=account?.type==='bot'?'BOT 账号仅可使用工作台':account?.blocked&&!['lobby-auth','watch-room','leave-room'].includes(event)?'账号已封禁，仅可浏览':null;
    if(account&&!isSuperAdmin(session.username)){
      const playEvents=new Set(['create-room','join-room','take-seat','swap-setup','randomize-setup','mirror-setup','toggle-ready','start-game','move','resign','draw-vote','undo-move','layout-load']);
      const chatEvents=new Set(['lobby-chat-message','chat-message','chat-react']);
      if(playEvents.has(event)&&!groupCan(session.username,'play'))error='你所在分组已暂停下棋功能';
      if(chatEvents.has(event)&&!groupCan(session.username,'chat'))error='你所在分组已暂停聊天功能';
    }
    if(error){socket.emit('game-error',error);const ack=packet.at(-1);if(typeof ack==='function')ack({ok:false,error});return;}
    next();
  });
  socket.on('chat-moderate', (payload = {}) => {
    const room=rooms.get(socket.data.roomCode);
    if(!isRoomManager(room,socket))return replyError(socket,'只有房主或管理员可以管理房间聊天');
    room.chatMuted ||= [];
    const rank = userRank(socket.data.username);
    let error;
    if (payload.action === 'ban' || payload.action === 'unban') {
      if (!isSuperAdmin(socket.data.username)) return replyError(socket, '只有管理员可以封禁');
      error = changeBan(globalBans, payload, rank);
      if (!error) { saveLobbyModeration(); broadcastModeration(); }
    } else {
      error = changeChat(room.chat, room.chatMuted, payload, rank, socket.data.username);
    }
    if(error)return replyError(socket,error);
    emitRoom(room);
  });
  socket.on('chat-react', (payload = {}) => {
    const username=authSocket(socket,payload);
    if(!username)return replyError(socket,'请先登录');
    if(!EMOJIS.includes(payload.emoji))return;
    const groupScope=typeof payload.scope==='string'&&payload.scope.startsWith('group:');
    const group=groupScope?groupData.groups[cleanGroupId(payload.scope.slice(6))]:null;
    if(groupScope){
      if(!group)return replyError(socket,'分组不存在');
      normalizeAccount(accounts[username]);if(!isSuperAdmin(username)&&accounts[username].groupId!==group.id)return replyError(socket,'只能使用自己分组的聊天室');
      if((group.muted||[]).includes(username)||globalBans.includes(username))return replyError(socket,'你已被禁言或封禁');
      const message=group.chat.find(m=>m.id===payload.id);if(!message||message.recalled)return;
      message.reactions ||= {};const users=message.reactions[payload.emoji] ||= [];const index=users.indexOf(username);
      if(index<0)users.push(username);else users.splice(index,1);if(!users.length)delete message.reactions[payload.emoji];
      saveLobbyModeration();return;
    }
    const room=payload.scope==='lobby'?null:rooms.get(socket.data.roomCode);
    if(payload.scope!=='lobby'&&!room)return;
    const muted=room?room.chatMuted||[]:lobbyMutes;
    if(muted.includes(username)||globalBans.includes(username))return replyError(socket,'你已被禁言或封禁');
    const message=(room?room.chat:lobbyChat).find(m=>m.id===payload.id);
    if(!message||message.recalled)return;
    message.reactions ||= {};
    const users=message.reactions[payload.emoji] ||= [];
    const index=users.indexOf(username);
    if(index<0)users.push(username);else users.splice(index,1);
    if(room)emitRoom(room);else {saveLobbyModeration();broadcastChat();}
  });
  socket.on('lobby-auth', payload => { if(authSocket(socket,payload,true)){socket.emit('announcements',announcements.map(m=>({...m,...accountProfile(m.name)})));socket.emit('lobby-chat',lobbyChat.map(m=>({...m,...accountProfile(m.name),admin:isSuperAdmin(m.name)})));socket.emit('moderation-state',{muted:lobbyMutes,banned:globalBans});} });
  socket.on('lobby-moderate', (payload = {}) => {
    if (!isSuperAdmin(socket.data.username)) return replyError(socket, '只有管理员可以管理大厅');
    const rank = userRank(socket.data.username);
    let error;
    if (payload.action === 'ban' || payload.action === 'unban') error = changeBan(globalBans, payload, rank);
    else error = changeChat(lobbyChat, lobbyMutes, payload, rank, socket.data.username);
    if (error) return replyError(socket, error);
    saveLobbyModeration();
    broadcastChat();
    broadcastModeration();
  });
  socket.on('recall-own', (payload = {}) => {
    const scope = payload.scope === 'lobby' ? 'lobby' : 'room';
    const room = scope === 'lobby' ? null : rooms.get(socket.data.roomCode);
    if (scope === 'room' && !room) return replyError(socket, '不在房间中');
    const messages = scope === 'lobby' ? lobbyChat : room.chat;
    const message = messages.find(m => m.id === payload.id);
    if (!message || message.recalled) return replyError(socket, '消息不存在');
    if (message.name !== socket.data.username) return replyError(socket, '只能撤回自己的消息');
    if (Date.now() - message.time > 5 * 60 * 1000) return replyError(socket, '超过 5 分钟，无法撤回');
    message.text = '[已撤回]'; message.recalled = true; delete message.reactions;
    if (scope === 'lobby') { saveLobbyModeration(); broadcastChat(); }
    else emitRoom(room);
  });
  socket.on('lobby-chat-message', (payload = {}) => {
    const username = authSocket(socket, payload, true);
    if (!username) return replyError(socket, '请先登录账号');
    if (lobbyMutes.includes(username) || globalBans.includes(username)) return replyError(socket, '你已被大厅禁言或封禁');
    const text = String(payload.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 8000);
    if (!text) return;
    const message = { id: crypto.randomUUID(), name: username, admin: !!accounts[username]?.admin, text, time: Date.now() };
    lobbyChat = [...lobbyChat, message].slice(-100);
    saveLobbyModeration();
    broadcastChat();
    const mentions = new Set([...text.matchAll(/(?:^|[^A-Za-z0-9_\u4e00-\u9fff@])@([A-Za-z0-9_\u4e00-\u9fff]+)/g)].map(m => canonicalUsername(m[1])));
    for (const target of io.sockets.sockets.values()) {
      const session = sessions.get(target.data.authToken);
      if (session && session.expiresAt > Date.now() && session.username !== username && mentions.has(session.username)) {
        target.emit('chat-mention', { ...message, code: 'lobby' });
      }
    }
  });
  socket.on("add-bot", ({ seat, username } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!isRoomManager(room, socket)) return replyError(socket, "只有房主或管理员可以添加 BOT");
    if (room.rated && room.phase === 'playing') return replyError(socket, "Rated 比赛开始后不能更换参赛账号");
    if (room.phase === "finished" || !room.activeSeats.includes(seat) || room.players.some(p => p.seat === seat)) return replyError(socket, "该座位不能添加 BOT");
    if (room.phase === "playing" && !room.pieces.some(p => p.owner === seat && p.position)) return replyError(socket, "该方向已退出对局");
    const error = botAPI.attach(room, seat, username);
    if (error) return replyError(socket, error);
    emitRoom(room);
  });

  socket.emit("board-meta", publicBoard());
  socket.emit("room-list", roomSummaries());

  socket.on("create-room", (payload = {}) => {
    if (socket.data.roomCode) return replyError(socket, "你已经在房间中");
    const username = authSocket(socket, payload);
    if (!username) return replyError(socket, "请先登录账号");
    const quota=canCreateRoom(username);if(!quota.ok)return replyError(socket,quota.error);
    const capacity = [2, 3, 4].includes(Number(payload.capacity)) ? Number(payload.capacity) : 4;
    const mode = capacity === 4 && payload.mode === "alliance" ? "alliance" : "ffa";
    const rated = false; // Determined from the complete roster at start.
    const code = randomCode();
    const seats = activeSeats(capacity);
    const player = makePlayer(seats[0], username, socket);
    const room = {
      code,
      name: String(payload.name || "").trim().slice(0, 40) || code,
      capacity,
      mode,
      rated,
      activeSeats: seats,
      players: [player],
      pieces: createArmy(seats[0]),
      phase: "setup",
      hostName: player.name,
      turn: null,
      winner: null,
      lastMove: null,
      moveTrails: {},
      eliminationOrder: [],
      ratingSettled: false,
      ratedParticipants: null,
      ratingChanges: null,
      botDebugEnabled: false,
      logs: [],
      privateLogs: new Map(),
      chat: [],
      spectators: new Map(),
      createdAt: Date.now(),
      creatorUsername: username,
      keepRoomHistory: !!groupForUser(username)?.keepRoomHistory,
    };
    rooms.set(code, room);
    useRoomQuota(username);
    addLog(room, `${player.name} 创建了房间`);
    joinSocket(socket, room, player);
    emitLobby();
  });

  socket.on("join-room", (payload = {}) => {
    const code = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const room = rooms.get(code);
    if (!room) return replyError(socket, "没有找到这个房间");
    const username = authSocket(socket, payload);
    if (!username) return replyError(socket, "请先登录账号");
    if(!groupCan(username,'play'))return replyError(socket,'你所在分组已暂停下棋功能');

    if (payload.token) {
      const returning = room.players.find((player) => player.token === payload.token);
      if (returning && !returning.isBot && (returning.username || returning.name) === username) return joinSocket(socket, room, returning);
    }

    if (resumeExistingMember(socket, room, username)) return;
    enterRoom(socket, room, username);
  });

  socket.on("watch-room", (payload = {}) => {
    const username = authSocket(socket, payload);
    if (!username) return replyError(socket, "请先登录账号");
    const code = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const room = rooms.get(code);
    if (!room) return replyError(socket, "没有找到这个房间");
    if (socket.data.roomCode) return replyError(socket, "你已经在房间中");
    if (resumeExistingMember(socket, room, username)) return;
    enterRoom(socket, room, username);
  });

  socket.on("take-seat", ({ seat } = {}) => {
    if(!groupCan(socket.data.username,'play'))return replyError(socket,'你所在分组已暂停下棋功能');
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase === "finished") return replyError(socket, "对局已经结束");
    if (room.rated && room.phase === "playing") return replyError(socket, "排位对局开局后不能接替座位");
    if (!room.activeSeats.includes(seat)) return replyError(socket, "该方向不在本局中");
    if (room.players.some((item) => item.seat === seat)) return replyError(socket, "这个方向已经有人");
    const existing = room.players.find((item) => item.socketId === socket.id);
    const member = room.spectators.get(socket.id);
    const name = existing?.name || member?.name;
    const username = existing?.username || member?.username || name;
    if (!name) return replyError(socket, "你不在这个房间中");
    if (existing) {
      if (room.phase !== "setup") return replyError(socket, "请先离座，再接替其他方向");
      room.pieces = room.pieces.filter((piece) => piece.owner !== existing.seat);
      room.privateLogs.delete(existing.seat);
      existing.seat = seat; existing.ready = false; existing.eliminated = false;
      room.pieces.push(...createArmy(seat));
      socket.data.seat = seat;
      socket.emit("session", { code: room.code, token: existing.token, seat });
    } else {
      if (room.phase === "playing" && !room.pieces.some((piece) => piece.owner === seat && piece.position)) return replyError(socket, "该方向已经退出对局");
      const player = makePlayer(seat, username, socket);
      room.players.push(player);
      if (room.phase === "setup") room.pieces.push(...createArmy(seat));
      joinSocket(socket, room, player);
    }
    addLog(room, `${name} 落座${SEAT_NAMES[seat]}`);
    emitRoom(room);
  });

  socket.on("leave-seat", () => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase === "finished") return replyError(socket, "现在不能离座");
    if (room.rated && room.phase === "playing") return replyError(socket, "排位对局中请使用认输");
    const name = player.name, seat = player.seat;
    room.players = room.players.filter((item) => item !== player);
    if (room.phase === "setup") {
      room.pieces = room.pieces.filter((piece) => piece.owner !== seat);
      room.privateLogs.delete(seat);
    }
    room.spectators.set(socket.id, { name, socketId: socket.id });
    socket.data.seat = null; socket.data.spectator = true;
    socket.emit("session", { code: room.code, token: null, seat: null });
    addLog(room, `${name} 已离座，${room.phase === "playing" ? SEAT_NAMES[seat] + "棋子原位保留" : "转为观战"}`);
    if (room.phase === "playing" && room.turn === seat) advanceTurn(room);
    emitRoom(room);
  });

  socket.on("kick-member", ({ name,seat,memberId } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!isRoomManager(room, socket)) return replyError(socket, "只有房主或管理员可以踢人");
    name = typeof name === "string" ? name : "";
    if (!name || name === socket.data.username) return replyError(socket, "不能踢出自己");
    if (isSuperAdmin(name)) return replyError(socket, "不能对同级管理员操作");
    const player = seat ? room.players.find((item) => item.seat===seat&&item.name===name) : room.players.find((item) => item.name === name);
    if(room.phase==='finished')return replyError(socket,'已结束比赛保留参赛名单');
    if(room.rated && room.phase==='playing' && player && isSuperAdmin(socket.data.username))return replyError(socket,'请先结束 Rated 比赛，再管理房间');
    if (room.rated && room.phase === "playing" && player && !player.eliminated && !isSuperAdmin(socket.data.username)) return replyError(socket, "排位对局开始后不能踢出参战玩家");
    const spectator = [...room.spectators.entries()].find(([id, item]) => (!memberId||id===memberId)&&item.name === name);
    const targetId = player?.socketId || spectator?.[0];
    const target = targetId && io.sockets.sockets.get(targetId);
    if (!player && !target) return replyError(socket, "没有找到这个人");
    let removedSeat = null;
    if (target) {
      removedSeat = removeMember(room, target, "被房主或管理员踢出房间", room.phase === "playing");
      target.emit("kicked");
    } else {
      removedSeat = player.seat;
      room.players = room.players.filter((item) => item !== player);
      if (room.phase !== "playing") {
        room.pieces = room.pieces.filter((piece) => piece.owner !== player.seat);
        room.privateLogs.delete(player.seat);
      }
      addLog(room, `${player.name} 被房主或管理员踢出房间`);
    }
    if (room.phase === "playing" && removedSeat === room.turn) advanceTurn(room);
    emitRoom(room);
  });

  socket.on("close-room", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!isRoomManager(room, socket)) return replyError(socket, "只有房主或管理员可以关闭房间");
    if (room.rated && room.phase === "playing" && !isSuperAdmin(socket.data.username)) return replyError(socket, "排位对局进行中不能关闭房间");
    if(room.phase!=='finished') { room.aborted=true; room.phase='finished'; room.finishedAt=Date.now(); room.turn=null; room.undo=null; room.winner='已关闭（不计分）'; addLog(room,'房间关闭，保留棋谱与聊天'); }
    emitRoom(room);
    for(const target of io.sockets.sockets.values())if(target.data.roomCode===room.code){
      target.emit('room-closed');target.leave(room.code);target.data.roomCode=null;target.data.seat=null;target.data.spectator=false;
    }
    for(const p of room.players){p.socketId=null;p.online=false;}
    room.spectators.clear();
    if(!room.keepRoomHistory)rooms.delete(room.code);
    botAPI.update(room);emitLobby();
  });

  socket.on('admin-finish-room', ({code}={}) => {
    if(!isSuperAdmin(socket.data.username))return replyError(socket,'需要管理员权限');
    const room=rooms.get(code||socket.data.roomCode);
    if(room)finishByAdmin(room);
  });

  socket.on("admin-close-room", ({ code } = {}) => {
    if (!isSuperAdmin(socket.data.username)) return replyError(socket, "只有管理员可以解散房间");
    const key = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const room = rooms.get(key);
    if (!room) return replyError(socket, "没有找到这个房间");
    const ids = [...room.players.map((item) => item.socketId), ...room.spectators.keys()].filter(Boolean);
    rooms.delete(room.code);
    botAPI.update(room);
    for (const id of ids) {
      const target = io.sockets.sockets.get(id);
      if (!target) continue;
      target.emit("room-closed"); target.leave(room.code);
      target.data.roomCode = null; target.data.seat = null; target.data.spectator = false;
    }
    emitLobby();
  });

  socket.on("set-bot-debug", ({ enabled } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!isRoomManager(room, socket)) return replyError(socket, "只有房主或管理员可以切换 BOT 调试模式");
    if (!isPureBotRoom(room)) return replyError(socket, "只有全部参赛者都是 BOT 时才能开启调试模式");
    if (typeof enabled !== "boolean") return replyError(socket, "调试模式参数错误");
    room.botDebugEnabled = enabled;
    addLog(room, `${isSuperAdmin(socket.data.username) ? "管理员" : "房主"}${enabled ? "开启" : "关闭"}了 BOT 调试观战`, "normal");
    emitRoom(room);
  });

  socket.on("toggle-admin-reveal", ({ enabled } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (!isSuperAdmin(socket.data.username)) return replyError(socket, "只有管理员可以开启明牌观战");
    if (typeof enabled !== "boolean") return replyError(socket, "明牌参数错误");
    const member = room.spectators.get(socket.id);
    if (!member) return replyError(socket, "仅旁观状态可以开启明牌观战");
    member.revealAll = enabled;
    addLog(room, `${member.name} ${enabled ? "开启" : "关闭"}了明牌观战`, "normal");
    emitRoom(room);
  });

  socket.on("chat-message", (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find((item) => item.socketId === socket.id);
    const name = player?.name || socket.data.username;
    if (!name) return;
    if ((room.chatMuted || []).includes(socket.data.username) || globalBans.includes(socket.data.username)) return replyError(socket, '你已被房间禁言或封禁');
    const text = String(payload.text || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 8000);
    if (!text) return;
    const message = { id: crypto.randomUUID(), name, admin: !!accounts[socket.data.username]?.admin, text, time: Date.now() };
    room.chat.push(message);
    room.chat = room.chat.slice(-100);
    const mentions = new Set([...text.matchAll(/(?:^|[^A-Za-z0-9_\u4e00-\u9fff@])@([A-Za-z0-9_\u4e00-\u9fff]+)/g)].map(match => canonicalUsername(match[1])));
    for (const member of [...room.players, ...room.spectators.values()]) {
      const username = member.username || member.name;
      if (member.isBot || !member.socketId || member.socketId === socket.id ||
          username === socket.data.username || !mentions.has(username)) continue;
      io.sockets.sockets.get(member.socketId)?.emit('chat-mention', { ...message, code: room.code });
    }
    emitRoom(room);
  });

  socket.on('rename-room', ({name} = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostName !== socket.data.username) return replyError(socket, '只有房主可以修改房间名称');
    if (typeof name !== 'string' || name.length > 40) return replyError(socket, '房间名称最多 40 字');
    room.name = name.trim() || room.code; emitRoom(room);
  });
  socket.on('undo-move', () => {
    const {room, player} = playerForSocket(socket);
    if (!room || !canUndo(room, player)) return replyError(socket, '只能撤回本人未造成棋子死亡的上一步，且下一步未走出、对局未结束');
    room.drawOffer=null;
    const undo = room.undo;
    Object.assign(room, structuredClone(undo.state));
    room.privateLogs = new Map(undo.privateLogs);
    for (const p of room.players) p.eliminated = undo.eliminated.find(([seat]) => seat === p.seat)?.[1] || false;
    room.undo = null;
    addLog(room, `${player.name} 撤回了上一步`);
    emitRoom(room);
  });
  socket.on('layout-save', async ({name} = {}) => {
    const {room, player} = playerForSocket(socket);
    if (!room || !player || room.phase !== 'setup') return replyError(socket, '请先落座并进入布阵阶段');
    const account = accounts[player.username];
    if ((account.layouts || []).length >= 3) return replyError(socket, '最多保存三个阵型，请先删除一个');
    const valid = validateSetup(room.pieces, player.seat);
    if (!valid.ok) return replyError(socket, valid.message);
    const layout = {name: String(name || '我的阵型').trim().slice(0, 30) || '我的阵型',
      pieces: room.pieces.filter(p => p.owner === player.seat).map(p => ({type:p.type, row:BOARD.byId.get(p.position).row, col:BOARD.byId.get(p.position).col}))};
    account.layouts ||= []; account.layouts.push(layout);
    try { await saveAccounts.flush(); emitRoom(room); } catch { account.layouts.pop(); replyError(socket, '保存失败，请重试'); }
  });
  socket.on('mirror-setup', () => {
    const {room, player} = playerForSocket(socket);
    if (!room || !player || room.phase !== 'setup' || player.ready) return replyError(socket, '只能在未准备时翻转布阵');
    const pieces = room.pieces.map(p => {
      if (p.owner !== player.seat) return p;
      const node = BOARD.byId.get(p.position);
      return {...p, position:`${player.seat}-${node.row}-${4-node.col}`};
    });
    const valid = validateSetup(pieces, player.seat);
    if (!valid.ok) return replyError(socket, valid.message);
    room.pieces = pieces; emitRoom(room);
  });
  socket.on('layout-delete', async ({index} = {}) => {
    const account = accounts[socket.data.username];
    if (!Number.isInteger(index) || !account?.layouts?.[index]) return replyError(socket, '阵型不存在');
    const old = account.layouts; account.layouts = old.filter((_, i) => i !== index);
    try { await saveAccounts.flush(); const room = rooms.get(socket.data.roomCode); if(room) emitRoom(room); }
    catch { account.layouts = old; replyError(socket, '删除失败，请重试'); }
  });
  socket.on('layout-load', ({index} = {}) => {
    const {room, player} = playerForSocket(socket);
    if (!room || !player || room.phase !== 'setup' || player.ready) return replyError(socket, '请先取消准备');
    const layout = Number.isInteger(index) && accounts[player.username]?.layouts?.[index];
    if (!layout) return replyError(socket, '阵型不存在');
    const army = createArmy(player.seat), remaining = [...army];
    for (const cell of layout.pieces) {
      const i = remaining.findIndex(p => p.type === cell.type);
      if (i < 0) return replyError(socket, '阵型数据无效');
      remaining.splice(i, 1)[0].position = `${player.seat}-${cell.row}-${cell.col}`;
    }
    const valid = validateSetup(army, player.seat);
    if (remaining.length || !valid.ok) return replyError(socket, '阵型数据无效');
    room.pieces = room.pieces.filter(p => p.owner !== player.seat).concat(army); emitRoom(room);
  });
  socket.on("swap-setup", ({ from, to } = {}) => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "setup" || player.ready) return;
    const a = pieceAt(room.pieces, from);
    const b = pieceAt(room.pieces, to);
    if (!a || !b || a.owner !== player.seat || b.owner !== player.seat) {
      return replyError(socket, "请选择两枚己方棋子交换位置");
    }
    const fromNode = BOARD.byId.get(from);
    const toNode = BOARD.byId.get(to);
    if (!fromNode || !toNode || fromNode.kind === "camp" || toNode.kind === "camp") return;
    [a.position, b.position] = [b.position, a.position];
    player.ready = false;
    emitRoom(room);
  });

  socket.on("randomize-setup", () => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "setup" || player.ready) return;
    room.pieces = room.pieces.filter((piece) => piece.owner !== player.seat);
    room.pieces.push(...createArmy(player.seat));
    emitRoom(room);
  });

  socket.on("toggle-ready", () => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "setup") return;
    if (!player.ready) {
      const result = validateSetup(room.pieces, player.seat);
      if (!result.ok) return replyError(socket, result.message);
    }
    player.ready = !player.ready;
    addLog(room, `${player.name}${player.ready ? "已准备" : "取消准备"}`);
    emitRoom(room);
  });

  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "setup") return;
    if (!isRoomManager(room, socket)) return replyError(socket, "只有房主或管理员可以开始对局");
    if (room.players.length !== room.capacity) return replyError(socket, "请等待所有玩家加入");
    if (!room.players.every((item) => item.ready)) return replyError(socket, "仍有玩家没有准备");
    for (const piece of room.pieces) { piece.initialPosition = piece.position; piece.moved = false; }
    room.phase = "playing";
    room.ply=0;room.noCapturePly=0;room.initialPlayerCount=room.players.length;
    room.hasBotParticipant=room.players.some(p=>p.isBot);delete room.botQuietMoves;
    const bots=room.players.filter(p=>p.isBot).length;
    room.ratingPool=bots===0?'human':bots===room.players.length?'bot':null;
    room.rated=!!room.ratingPool;
    room.turn = room.activeSeats[0];
    room.lastMove = null;
    room.moveTrails = {};
    room.replay = { version: 1, code: room.code, startedAt: Date.now(), frames: [], logs: [] };
    room.eliminationOrder = [];
    room.ratedParticipants = room.rated ? room.players.map((item) => ({
      seat: item.seat, username: item.username || item.name, name: item.name,
      rating: accountProfile(item.username || item.name).rating,
    })) : null;
    addLog(room, "对局开始", "success");
    emitRoom(room);
  });

  socket.on("move", ({ from, to } = {}) => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || player.eliminated) return;
    const result = applyMove(room, player, from, to);
    if (!result.ok) replyError(socket, result.message);
  });

  socket.on("resign", () => {
    const { room, player } = playerForSocket(socket);
    if (!room || !player || room.phase !== "playing" || player.eliminated) return;
    room.undo = null;
    eliminate(room, player.seat, "已认输");
    checkWinner(room);
    if (room.turn === player.seat) advanceTurn(room);
    emitRoom(room);
  });

  socket.on('draw-vote', ({accept,offerId}={})=>{
    const {room,player}=playerForSocket(socket);
    if(!room||!player)return replyError(socket,'观众不能参与和棋表决');
    const error=voteDraw(room,player,accept,offerId);if(error)replyError(socket,error);
  });

  socket.on("leave-room", (payload, ack) => {
    if(typeof payload==='function')ack=payload;
    const done = () => { if (typeof ack === 'function') ack({ ok: true }); };
    const room = rooms.get(socket.data.roomCode);
    if (!room) {
      socket.data.roomCode = null; socket.data.seat = null; socket.data.spectator = false;
      done(); return;
    }
    const player = room.players.find((item) => item.socketId === socket.id);
    const member = room.spectators.get(socket.id);
    const departedName = player?.name || member?.name;
    let removedSeat = null;
    if (room.rated && room.phase === "playing" && player && !player.eliminated) {
      removedSeat = player.seat;
      eliminate(room, player.seat, "离开房间，判定认输");
      player.socketId = null; player.online = false;
      socket.leave(room.code); socket.data.roomCode = null; socket.data.seat = null;
      checkWinner(room);
    } else {
      removedSeat = removeMember(room, socket, "离开了房间", room.phase === "playing");
    }
    if (room.phase === "playing" && removedSeat === room.turn) advanceTurn(room);
    transferHostIfNeeded(room, departedName);
    emitRoom(room);
    emitLobby();
    done();
  });

  socket.on("disconnect", () => {
    if (socket.data.spectator) {
      const room = rooms.get(socket.data.roomCode);
      room?.spectators.delete(socket.id);
      if (room) emitRoom(room);
      emitLobby();
      return;
    }
    const { room, player } = playerForSocket(socket);
    if (!room || !player || player.socketId !== socket.id) return;
    player.online = false;
    player.socketId = null;
    addLog(room, `${player.name} 已断开，等待重连`);
    emitRoom(room);
  });
});

app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在'}));
app.use((error,req,res,next)=>{console.error('请求失败:',error.message);if(!res.headersSent)res.status(500).json({error:'操作未保存，请稍后重试'});else next(error);});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  try {
    const results=await Promise.allSettled([saveRooms.flush(), saveAccounts.flush(), saveLobbyModeration.flush(), hosted?.flushSave?.()]);
    if(results.some(r=>r.status==='rejected'))throw Error('存档失败');
    process.exit(0);
  } catch {
    process.exit(1);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`四国军棋已启动：${tlsCert ? 'https' : 'http'}://localhost:${PORT}`);
});
