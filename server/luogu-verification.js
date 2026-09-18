import crypto from 'node:crypto';

const CHALLENGE_TTL = 10 * 60 * 1000;
const GRANT_TTL = 10 * 60 * 1000;
const LUOGU_BASE = 'https://www.luogu.com.cn';
const headers = { 'user-agent': 'SiguoJunqi-Luogu-Verification/1.0', 'x-luogu-type': 'content-only', accept: 'application/json' };

function objects(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  output.push(value);
  for (const child of Object.values(value)) objects(child, output);
  return output;
}

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function userId(value) {
  if (!value || typeof value !== 'object') return null;
  return integer(value.uid ?? value.id ?? value.userId);
}

function hasBalloon(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    const label = `${key} ${typeof child === 'string' ? child : ''}`.toLowerCase();
    if (/(气球|balloon|icpc|xcpc)/i.test(label) && (typeof child !== 'number' || child > 0)) return true;
    if (child && typeof child === 'object' && hasBalloon(child)) return true;
  }
  return false;
}

async function luoguJson(pathname) {
  const response = await fetch(LUOGU_BASE + pathname, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`洛谷返回 HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('json')) throw new Error('洛谷未返回可验证的数据，请确认页面公开后重试');
  const text=await response.text();
  try{return JSON.parse(text);}catch{throw new Error('洛谷返回了网页而不是验证数据，可能触发了访问限制，请稍后重试');}
}

function parsePaste(payload, expectedCode) {
  for (const object of objects(payload)) {
    const content = [object.data, object.content, object.text, object.markdown].find(value => typeof value === 'string');
    if (content?.trim() !== expectedCode) continue;
    const author = object.user ?? object.author ?? object.creator;
    const uid = userId(author) ?? integer(object.userId ?? object.authorId ?? object.uid);
    if (uid) return { uid };
  }
  throw new Error('剪贴板正文不是本次随机字符串，或无法确认剪贴板作者');
}

function parseUser(payload, expectedUid) {
  const candidates = objects(payload).filter(object => userId(object) === expectedUid);
  const user = candidates.find(object => 'ccfLevel' in object) || candidates.find(object => typeof object.name === 'string');
  if (!user) throw new Error('无法读取该洛谷用户');
  const ccfLevel = Math.max(0, Number(user.ccfLevel) || 0);
  return { uid: expectedUid, name: String(user.name || user.username || expectedUid), ccfLevel, balloon:hasBalloon(user), blueHook: ccfLevel >= 3 };
}

export function installLuoguVerification(app, { accounts, authorize, saveAccounts }) {
  const challenges = new Map(), grants = new Map();
  const clean = () => {
    const now = Date.now();
    for (const [id, item] of challenges) if (item.expiresAt <= now) challenges.delete(id);
    for (const [id, item] of grants) if (item.expiresAt <= now) grants.delete(id);
  };
  const ownerOf = (uid, type) => Object.entries(accounts).find(([, account]) => Number(account.luogu?.uid) === uid && (!type || account.type === type))?.[0] || null;

  app.post('/api/luogu/challenge', (req, res) => {
    clean();
    const uid = integer(req.body?.uid), purpose = req.body?.purpose === 'bind' ? 'bind' : 'register';
    if (!uid) return res.status(400).json({ error: '请输入正确的洛谷 UID' });
    const session = authorize(req);
    if (purpose === 'bind' && !session?.username) return res.status(401).json({ error: '请先登录' });
    if (purpose === 'bind' && accounts[session.username]?.luogu && Number(accounts[session.username].luogu.uid) !== uid) return res.status(409).json({ error: '本站账号已经绑定洛谷身份，不能改绑其他 UID' });
    const accountType = purpose === 'bind' ? accounts[session?.username]?.type : req.body?.accountType;
    if (!['human', 'bot'].includes(accountType)) return res.status(400).json({ error: '账号类型无效' });
    const occupied = ownerOf(uid, accountType);
    if (occupied && occupied !== session?.username) return res.status(409).json({ error: '这个洛谷账号已经绑定了其他本站账号' });
    const id = crypto.randomUUID(), code = `JUNQI-${crypto.randomBytes(18).toString('base64url')}`;
    challenges.set(id, { uid, purpose, accountType, username: session?.username || null, code, expiresAt: Date.now() + CHALLENGE_TTL });
    res.json({ challengeId: id, code, expiresIn: CHALLENGE_TTL / 1000 });
  });

  app.post('/api/luogu/verify', async (req, res) => {
    clean();
    const challenge = challenges.get(String(req.body?.challengeId || ''));
    if (!challenge) return res.status(400).json({ error: '验证已过期，请重新生成随机字符串' });
    const pasteId = String(req.body?.pasteId || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pasteId)) return res.status(400).json({ error: '请输入正确的洛谷剪贴板 ID' });
    const session = authorize(req);
    if (challenge.purpose === 'bind' && session?.username !== challenge.username) return res.status(401).json({ error: '登录状态已变化，请重新验证' });
    let paste, user;
    try {
      [paste, user] = await Promise.all([
        luoguJson(`/paste/${encodeURIComponent(pasteId)}?_contentOnly=1`).then(data => parsePaste(data, challenge.code)),
        luoguJson(`/user/${challenge.uid}?_contentOnly=1`).then(data => parseUser(data, challenge.uid)),
      ]);
    } catch (error) {
      return res.status(502).json({ error: `洛谷验证失败：${error.message}` });
    }
    if (paste.uid !== challenge.uid) return res.status(403).json({ error: '该剪贴板不是由所填洛谷账号发布的' });
    const occupied = ownerOf(challenge.uid, challenge.accountType);
    if (occupied && occupied !== challenge.username) return res.status(409).json({ error: '这个洛谷账号已经绑定了其他本站账号' });
    challenges.delete(String(req.body.challengeId));
    const verification = { uid: user.uid, name: user.name, ccfLevel: user.ccfLevel, balloon:user.balloon, blueHook: user.blueHook, verifiedAt: Date.now() };
    if (challenge.purpose === 'bind') {
      const account = accounts[challenge.username];
      if (!account) return res.status(404).json({ error: '本站账号不存在' });
      account.luogu = verification; account.verified = true;
      await saveAccounts.flush();
      return res.json({ ok: true, luogu: verification });
    }
    if (user.ccfLevel <= 0 && !user.balloon) return res.status(403).json({ error: '注册要求洛谷账号具有认证钩子或竞赛气球' });
    const token = crypto.randomBytes(32).toString('base64url');
    grants.set(token, { verification, accountType:challenge.accountType, expiresAt: Date.now() + GRANT_TTL });
    res.json({ verificationToken: token, luogu: verification, direct: user.blueHook, expiresIn: GRANT_TTL / 1000 });
  });

  return {
    consume(token, accountType) {
      clean();
      const key = String(token || ''), grant = grants.get(key);
      if (!grant) return null;
      grants.delete(key);
      if (grant.accountType !== accountType || ownerOf(grant.verification.uid, accountType)) return null;
      return grant.verification;
    },
    ownerOf,
    async bindByAdmin(username, rawUid) {
      const account=accounts[username],uid=integer(rawUid);
      if(!account||account.status==='pending')throw new Error('只能绑定已审核账号');
      if(!uid)throw new Error('请输入正确的洛谷 UID');
      if(account.luogu&&Number(account.luogu.uid)!==uid)throw new Error('该本站账号已经绑定其他洛谷 UID');
      const occupied=ownerOf(uid,account.type);
      if(occupied&&occupied!==username)throw new Error(`这个洛谷 UID 已绑定另一个${account.type==='bot'?' BOT':'玩家'}账号`);
      const user=await luoguJson(`/user/${uid}?_contentOnly=1`).then(data=>parseUser(data,uid));
      account.luogu={uid:user.uid,name:user.name,ccfLevel:user.ccfLevel,balloon:user.balloon,blueHook:user.blueHook,verifiedAt:Date.now(),adminBound:true};
      account.verified=true;await saveAccounts.flush();return account.luogu;
    },
  };
}

export const __test = { parsePaste, parseUser, hasBalloon };
