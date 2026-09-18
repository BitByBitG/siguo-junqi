# BOT API

## 自动和棋与账号权限（2.5.8）

已移除 `quietMoves`、`quietMoveLimit` 和 BOT 五步判负。有 BOT 参加的对局，连续 16 次全桌合法走子无任何棋子阵亡，或全桌总步数达到开局位置数 × 128，服务器自动和棋，无需调用 draw、不计算 Rating。BOT 出局不取消上限；同账号占多个位置按多个位置计数。纯人类对局不适用。每个 BOT 账号有独立单步时限，默认 5 秒，由管理员设置。

GET `/api/bot/rooms/:code` 新增／明确以下字段：

| 字段 | 含义 |
| --- | --- |
| `ply` | 全桌累计合法走子次数 |
| `noCapturePly` | 全桌连续无棋子阵亡的步数 |
| `noCapturePlyLimit` | 16 |
| `initialPlayerCount` | 开局参赛位置数，不随出局减少 |
| `totalPlyLimit` | 开局位置数 × 128（256／384／512） |
| `drawn` | 是否以和棋结束 |
| `autoDrawReason` | `no-capture`、`move-limit` 或 `null`；null 可表示申请和棋或尚未自动和棋 |

计数仅由服务器推进：合法走子计一次，重复 requestId 不重复计步，无效请求、布阵与聊天不计步。任意方战损清零 `noCapturePly`；悔棋回退计数，重启保留计数。达到总步数上限的那一步即使吃子也可自动和棋；但如果该步已产生正常胜负，优先判胜负。结束时 `phase` 为 `finished`，程序应停止提交动作。完整日志不足的旧存档不会伪造无战损计数。

参考程序已去除第五步强制攻击的评分惩罚与筛选。私人程序不会自动改写；不要继续把“无合法攻击”当作即将判负。

BOT 登录后只使用工作台、程序管理和 BOT 接口，不能访问其他账号业务接口。用户名匹配忽略大小写，返回值保留账号原始拼写。全站禁言只限制聊天；封禁账号可登录和读取允许的数据，但不能提交操作或托管程序。

## 选择接入方式

| 方式 | 适合 | 运行位置 |
| --- | --- | --- |
| [BOT 工作台](/bot-studio.html) | 粘贴纯 JavaScript | 网站服务器的隔离环境 |
| 外部客户端 | Node.js 或自行实现协议的其他语言 | 你自己的电脑或服务器 |

注册时选择 BOT 账号，审核通过后即可登录。房主必须是真人，在布阵阶段的「添加 BOT 账号」面板选择账号和方向。开局后全 BOT 自动计 BOT Rating，全人类计人类 Rating，混合对局不计分。Rated 开始后不能更换参赛账号。一个账号可分配多个房间、多个方向，每个位置有独立 assignmentId 与托管记忆。同账号多位置分差取平均，每局只更新一次账号 Rating；结束后不再出现在活跃 assignments 中，棋谱保留在历史比赛。

房主先离座，再为所有位置添加 BOT，即可观战纯 BOT 比赛。全部准备后仍需房主点击开始。返回首页或退出网页登录不会停止已启动的托管程序；停止运行请在工作台点「停止托管」。

## 工作台：可直接粘贴的最小程序

### 和棋接口（2.4.0）

棋局包含 `drawOffer: null | {id, proposer, accepted, time}`，`accepted` 是已同意的方向数组。`POST /api/bot/rooms/:code/draw` 使用相同的 `assignmentId`、`revision`、`requestId`，另加 `accept: true | false`、`offerId`。无申请时省略 `offerId` 并提交 `accept:true` 发起申请；已有申请时必须传当前 `offerId` 表示同意／拒绝。存活位置可以不在本方回合提交，已出局位置不能表态。所有存活位置同意才和棋，不结算 Rating。继续走棋、人员变化或拒绝会取消申请；不暂停当前 BOT 的走棋计时。自动和棋不需要此接口。

托管程序返回 `{action:'draw',accept:true,offerId:state.drawOffer.id}` 即表示同意；拒绝用 `accept:false`。非本方回合收到申请时，可额外调用一次 `act`，此时 `drawOnly:true`，只接受 draw 返回值，其余返回值忽略。没有实现表态逻辑的 BOT 不会被自动同意。参考处理：

```js
if (state.drawOffer && !state.drawOffer.accepted.includes(state.viewerSeat)) {
  return {action:'draw', accept:false, offerId:state.drawOffer.id}; // 可替换成自己的判断
}
```

下面的示例只随机选择合法走法，用于验证接入，不代表策略强度。默认阵型已经合法，因此可以直接准备。

```javascript
function act(state) {
  if (state.phase === 'setup') return {action: 'ready', ready: true};
  const moves = state.legalMoves || [];
  if (!moves.length) return {action: 'resign'};
  const move = moves[Math.floor(Math.random() * moves.length)];
  return {
    action: 'move', from: move.from, to: move.to,
    memory: {steps: (state.memory?.steps || 0) + 1}
  };
}
```

将全文粘贴到工作台，点击「保存并启动」。更完整的参考策略可以打开 [可粘贴 BOT 源码](/downloads/bot-studio-bot.js)。

### 输入、返回值与限制

必须定义同步 `function act(state)`。输入包含下文的过滤棋局，以及 `thinkTimeMs`（本次可用计算时间）、`programPrepared`（已提交过布局）、`memory`（上次返回的记忆，初次为 null）。每次调用的全局变量都会重置，不要依赖它们保存策略状态。

返回以下任一对象：

| action | 其他字段 | 用途 |
| --- | --- | --- |
| `draw` | `accept`、已有申请时的 `offerId` | 申请、同意或拒绝和棋 |
| setup | pieces: [{id, position}, ...] | 提交本方全部 25 枚的布局 |
| ready | ready: true 或 false | 准备或取消准备 |
| move | from, to | 提交一手 |
| resign | 无 | 对局中认输 |

所有返回值都可带 JSON `memory`，其 JSON 字符串最多 16384 个字符。托管按 assignmentId 隔离记忆；重新保存程序会清除旧运行状态。布阵程序在 `programPrepared` 为 false 时提交 setup，下一次调用返回 ready，以免无限重新布阵。

程序源码最多 **1 MiB（UTF-8 字节）**。QuickJS 环境不提供 Node.js、网络、文件、系统命令、模块导入或异步定时器。JS 堆限制 48 MiB，WASM 内存上限 64 MiB，并有 Worker 强制超时。请使用 `Date.now()` 检查自己的截止时间，提前结束搜索并返回合法着法。

对局每步总限时按 BOT 账号独立设置（1～120 秒，默认 5 秒），托管会留出读写与调度时间，实际传入预算可能更短。布阵调用也有运行预算。程序出错会显示错误并重试，无法在回合结束前提交合法着法仍会判负；错误本身不会自动取消 enabled。停止托管后才能使用外部客户端给同一位置提交操作。

## 外部程序与加密

对外的业务 API 使用 **HTTPS + 应用层加密**，不能直接用普通 JSON 请求下面列出的业务路径。纯明文业务请求通常返回 426。`Authorization` 和业务请求体均封装进加密消息，服务器解密后再进行账号、座位和走法校验。

Node.js 客户端可以下载 [secure-client.js](/downloads/secure-client.js)，放在自己的 ESM 项目里（package.json 设置 `"type":"module"`，或将该文件改名为 secure-client.mjs 并调整 import）。Node.js 18 及以上，无需额外 npm 包。

```javascript
import {createSecureClient} from './secure-client.js';
const client = createSecureClient(process.env.BOT_SERVER);
const login = await client.fetch('/api/bot/login', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({username: process.env.BOT_USERNAME,
                        password: process.env.BOT_PASSWORD})
});
const account = await login.json();
if (!login.ok) throw Error(account.error);
const headers = {Authorization: `Bearer ${account.token}`};
const response = await client.fetch('/api/bot/session', {headers});
if (!response.ok) throw Error((await response.json()).error);
const {assignments} = await response.json();
for (const seat of assignments) {
  const url = `/api/bot/rooms/${seat.code}?assignmentId=${encodeURIComponent(seat.assignmentId)}`;
  const result = await client.fetch(url, {headers});
  if (!result.ok) throw Error((await result.json()).error);
  const state = await result.json();
  console.log(seat.seat, state.phase, state.legalMoves.length);
}
```

该片段只登录并读取当前分配，不是自动比赛循环。实际客户端应持续轮询 session，按 assignmentId 独立维护状态，仅在自己的回合提交合法走法。直接运行完整示例可使用 [独立 BOT 程序](/downloads/siguo-junqi-bot.mjs)：

```bash
export BOT_SERVER='https://你的域名'
export BOT_USERNAME='你的BOT账号'
read -s -p 'BOT 密码: ' BOT_PASSWORD
export BOT_PASSWORD
node siguo-junqi-bot.mjs
```

### 自行实现加密协议

1. 客户端生成 RSA-OAEP 密钥对（参考客户端为 3072 位，SHA-256），POST `/api/crypto`，普通 JSON 为 `{publicKey: 公钥JWK}`。
2. 响应包含通道 `id` 与 Base64 `key`；使用 RSA 私钥解开 key，得到 32 字节 AES 密钥。
3. 每次请求使用随机 12 字节 IV、AES-256-GCM、128 位认证标签。AAD 为 UTF-8 `client-v1`。明文是 UTF-8 JSON：`{kind:"http",url:"/api/...",method:"GET",authorization:"Bearer ...",body:对象,time:毫秒时间戳,nonce:唯一字符串}`。登录请求没有 authorization；GET 可以省略 body。
4. 将 `{id,iv:Base64,data:Base64}` POST 到 `/api/secure`。data 是密文尾部拼接 GCM 认证标签，与 WebCrypto 输出一致。
5. 响应用相同 AES 密钥解密，AAD 为 `server-v1`。解密 JSON 的 `value` 是业务响应；同时校验 time 与 nonce。HTTP 状态码保留业务状态。

服务器接受时间偏差不超过两分钟的消息，并拒绝重复 nonce。通道过期或丢失后需重建；不要把密码、token、私钥或 AES 密钥写进公开日志。上述协议保障传输与完整性，服务器仍能处理明文；它不防御已被控制的登录终端。证书须被客户端正确验证，不要用跳过 TLS 校验解决部署问题。

## 认证与公开目录

`POST /api/bot/login` 提交 `{username,password}`，返回 `token, username, accountType`。后续业务请求携带 Bearer token。token 默认七天有效，退出、改密码、删除账号或服务器重启后需重新登录。普通玩家 token 访问 BOT 专属接口返回 403。

`GET /api/bots` 返回已审核 BOT 的 `username, rating, online, seats, turnLimitMs`，其中 seats 为占用位置数量，turnLimitMs 为该账号的单步时限。这个目录与真人 Rating 排名分开。在线状态来自最近 15 秒的 BOT API 活动，不等于登录了工作台。

## 读取接口

| 路径 | 内容 |
| --- | --- |
| GET /api/bot/board | nodes、roads、rails、straightRailLines、pieceInfo、turnLimitMs |
| GET /api/bot/session | apiVersion: 2、username、assignments 数组 |
| GET /api/bot/rooms/CODE?assignmentId=ID | 指定座位的棋局快照 |

session 的每个 assignment 为 `{code,seat,assignmentId}`；没有位置时数组为空。兼容字段 assignment 仅在恰好一个位置时提供对象，否则为 null。即使当前只有一个位置，也建议始终传 assignmentId，避免后来添加位置后产生歧义。board 与棋局响应目前仍标注 apiVersion: 1，这是与 session 不同的版本字段。

### 棋局字段

| 字段 | 含义 |
| --- | --- |
| code / assignmentId / revision | 房间码、分配标识、棋局版本 |
| viewerSeat / turn | 本方与当前回合，north / east / south / west |
| phase / mode | setup、playing、finished；ffa 或 alliance |
| activeSeats | 本局启用的方向，未启用方向不能进入或穿过 |
| occupiedSeats / livingSeats | 当前未出局的占用方向 / 仍有棋子的方向 |
| ready / eliminated / winner | 本方准备、出局、胜者 |
| serverTime / deadline | 服务器毫秒时间与 BOT 回合截止时间，没有时为 null |
| pieces | 仍在棋盘上的棋子 |
| records | 包含 position 为 null 的阵亡或出局棋子 |
| battles | 公开交战记录：attacker、defender 的 id 与 outcome |
| legalMoves | 本回合合法的 {from,to}；非本方回合等情况为空 |
| logs / lastMove | 本方可见战报 / 上一手 |

棋子字段为 `{id,owner,position,initialPosition,moved,type}`。己方和已公开身份有真实 type，其他方向包括盟友的暗子 type 均为 null；即使房主开启 Debug 或对局结束，BOT API 仍不额外泄露。id 是身份标识，不能根据数组顺序推测敌子。

己方位置 id 如 `north-0-0`：行列从 0 开始，row=0 是前排，row=5 是底排，col=0..4。中央位置应从 board.nodes 获取，不要自己拼接。特殊拐弯铁路以 `straightRailLines` 为准，不要仅凭屏幕几何方向判断合法性。

## 提交操作

所有动作 POST `/api/bot/rooms/CODE/ACTION`，共同字段：

```json
{
  "assignmentId": "从session取得的分配ID",
  "revision": 12,
  "requestId": "e072ecf6-9804-491b-8640-38a5d889061f",
  "from": "north-0-0",
  "to": "north-1-0"
}
```

| ACTION | 额外字段 | 条件 |
| --- | --- | --- |
| setup | pieces: [{id,position}, ...] | 未准备的布阵阶段，本方全部 25 枚、唯一 id 和位置 |
| ready | ready: 布尔值 | 布阵阶段，准备前校验阵型 |
| move | from、to | 本方回合、截止前、通过服务器走法校验 |
| resign | 无 | 已开始且该方向尚未结束 |

setup 不接受改变棋子类型；军旗在大本营、地雷在后两排、炸弹不在前排、行营初始留空。完整规则见 [规则](/rules.html)。

成功返回 `{ok:true,requestId,revision}`。requestId 为 6–80 位字母、数字、下划线或连字符，推荐 UUID。网络超时无法确定是否成功时，以相同 requestId 和完整原请求体重试，成功请求最近 128 条会去重。不要把旧 requestId 用于新动作。

revision 因棋局、布阵、准备、人员变化而更新，聊天与心跳不会使思考失效。收到 409 后重新读取，不要盲目重复旧局面；房主踢出再添加会生成新 assignmentId，旧分配不能控制新座位。

## 错误与恢复

| 状态 | 处理 |
| --- | --- |
| 400 | 格式、布局、走法或加密包不合法，检查 error |
| 401 | 登录失效，重新登录 |
| 403 | 账号或座位无权限，多座位却未传 assignmentId 也可能返回此状态 |
| 404 | 路径或资源不存在 |
| 409 | 棋局版本、分配、准备状态改变，或该位置已启用托管，重新查询并处理 |
| 426 | 使用了未加密业务请求，改用加密客户端 |
| 429 | 请求或验证过于频繁，等待后重试 |

BOT 回合按账号配置的时限从服务器切换回合开始计时，包含轮询与网络；`turnLimitMs` 给出完整时限，用 `deadline - serverTime` 估算本回合剩余时间并留出余量。到时未收到合法着法，服务器判该方负，不会替程序随机走一步。离座接替时保留原棋子，直接从当前 state 开始。

托管部署同时支持公网 HTTP 源站和本地 HTTPS；内部请求仅走服务器回环地址。若工作台显示离线，先检查是否已「保存并启动」、房主是否分配位置、错误提示及服务器日志。服务器刚重启时登录 token 会失效，但已保存且 enabled 的托管程序会重新建立连接。

## 工作台管理接口

这三个接口使用 BOT 账号的网页登录 token，同样通过加密通道，仅能操作自己的程序。

| 接口 | 请求 / 响应 |
| --- | --- |
| GET /api/program | source、enabled、message、assignments 等当前状态 |
| PUT /api/program | {source}，检查后保存并停止，清除旧程序记忆 |
| POST /api/program/run | {enabled:true/false}，启动或停止 |

源码文件随发布包提供，也可以 [下载这份 Markdown](/BOT_API.md)。
