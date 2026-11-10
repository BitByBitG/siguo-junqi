# 德州扑克 BOT 接口

BOT 账号默认允许参战，无需管理员额外开通德州扑克权限。账号本身仍需通过原有注册审核；封禁、分组暂停、建房额度与请求频率限制继续生效。管理员可显式停用账号的德州扑克权限（`holdemEnabled:false`），撤权立即离座弃牌。真人账号的开通流程不变。

本接口用于外部 Bot 程序。军棋工作台的 `act(state)` 托管程序、军棋 `assignmentId` 会话及军棋参考策略不能直接用于扑克。一个 Bot 账号在每桌只能占一个座位，可同时进入多桌，钱包在所有桌之间共用。

## 登录与通信

沿用 [BOT API 的加密通信](BOT_API.md#外部程序与加密)，使用 `bots/secure-client.js` 的 `createSecureClient()`。所有下列请求均经加密客户端发送，普通明文请求返回 426。先调用 `POST /api/bot/login`，请求体 `{username,password}`，随后在加密请求中携带 `Authorization: Bearer <token>`。德州扑克专用路径只接受 Bot 账号的普通登录会话，不接受真人或军棋托管会话；会话过期返回 401，需要重新登录。

## 接口

| 方法与路径 | 请求体 / 说明 |
| --- | --- |
| `GET /api/bot/holdem/wallet` | 可用 `balance`、牌桌 `tableChips`、下注 `committed`、合计 `total` 及发放配置 |
| `GET /api/bot/holdem/standings` | 含真人及 Bot 的筹码排名 |
| `GET /api/bot/holdem/rooms` | 牌桌摘要；`joined` 标识自己是否已进入 |
| `POST /api/bot/holdem/rooms` | 可选 `{name,max,stack,sb,time}` 创建房间；创建者为房主，返回 201 及牌桌状态 |
| `POST /api/bot/holdem/rooms/:id/join` | `{}` 进入 / 观战，返回自己的牌桌状态，可重复调用 |
| `GET /api/bot/holdem/rooms/:id` | 已进入者获取自己的牌桌状态 |
| `POST /api/bot/holdem/rooms/:id/action` | 下表中的操作，通常返回操作后的牌桌状态 |
| `POST /api/bot/holdem/rooms/:id/chat` | `{text}`，沿用聊天限频与禁言规则 |
| `POST /api/bot/holdem/rooms/:id/chat-action` | 沿用真人接口的表情、撤回及房主管理操作 |

创建参数范围：`max` 2–9（默认 6）、`stack` 200–100000（默认 2000）、小盲 `sb` 1–1000（默认 10）、`time` 10–120 秒（默认 30）。大盲为小盲两倍，默认买入至少为大盲十倍。

| `op` | 其他字段 | 行为 |
| --- | --- | --- |
| `seat` | `index`（从 0 开始）、可选 `buyIn` | 从钱包买入落座；默认买入 `stack`；范围为大盲十倍至 100000，且不可超过钱包余额 |
| `ready` | `ready:true/false`（必填） | 显式设置准备状态，重复同值不会取消准备 |
| `start` | 无 | 仅房主 / 管理员可开始，至少两人准备 |
| `bet` | `type`、`hand`、`turn`、`version`，加注另带 `amount` | 提交当前回合决策 |
| `stand` | 无 | 离座；手牌进行中自动弃牌，结算后退款 |
| `leave` | 无 | 离座并退出房间，返回 `{ok:true}` |
| `kick` | `username` | 仅房主 / 管理员可踢人 |
| `close` | 无 | 仅房主 / 管理员可关闭房间，退款，返回 `{ok:true}` |

`type` 支持 `fold`、`check`、`call`、`raise`、`allin`。`raise.amount` 为本轮下注的**目标总额**，不是追加金额。必须复制最新状态中的 `hand`、`turn`、`version`；旧版本或重复下注返回 409，应重新获取状态再决策。其他失败请求返回 `{error}`：400 参数/规则错误、401 登录失效、403 无权限、404 房间不存在、429 请求过频。下注以外的操作没有通用 requestId 去重；遇到网络错误先读取状态，确认是否已执行，再决定是否重试。

## 状态与牌局循环

`viewerName` 为当前 Bot 账号，`players` 为固定座位数组（空位为 `null`），每项含 `id`、`chips`、`ready`、`bet`、`total`、`folded`、`inHand` 和 `hole`。`phase` 为 `waiting`、`preflop`、`flop`、`turn`、`river` 或 `finished`。还包括公共牌 `board`、底池 `pot`、行动位 `turn`、手数 `hand`、版本 `version`、服务器时间 `serverTime` 和截止时间 `deadline`（毫秒时间戳）。

仅轮到自己时 `legal` 非空：`call` 为实际需付的跟注筹码（已受剩余筹码限制）、`min` 为完整加注最低目标、`max` 为全下目标、`canRaise` 为加注权。短码时允许用 `allin`；无法响应加注或未重新开放加注权时，仍以服务器规则校验为准。`legal.call===0` 可过牌，否则可跟注或弃牌。超时自动过牌 / 弃牌，使用牌桌统一时限，军棋 Bot 时限配置不作用于扑克。

牌值为整数 0–51：`rank=card%13+2`（14 为 A），`suit=Math.floor(card/13)`，花色依次为 ♠、♥、♣、♦。手牌进行中仅自己的 `hole` 可见，其他玩家底牌为 `null`，不返回牌堆。每手结束后公开本手所有参赛者底牌，下一手开始重新隐藏。

建议每秒轮询一次：进入 → 空位买入 → `ready:true` → 房主开始 → 根据 `legal` 决策 → 结束后重新准备。余额不足时等待发放 / 停止参战；不自动借贷。默认初始 10000、每日 2000，沿用北京时间每日发放、持久化及管理员配置。首次可参战时创建钱包；重连、重启、反复开关权限不会重复发初始筹码。Bot 筹码与真人相同方式保存和结算，不影响军棋 Rating。

## 可运行示例

仓库提供 `bots/holdem-bot.mjs`，策略为可过牌则过牌，否则跟注，仅用于验证接口。需要 Node.js 18+，无需额外依赖：

```bash
BOT_SERVER=https://your-server.example \
BOT_USERNAME=YourBot BOT_PASSWORD='your-password' BOT_ROOM=ROOM_ID \
node bots/holdem-bot.mjs
```

先由房主创建牌桌，把房间 ID 填入 `BOT_ROOM`；Bot 会自动进入、选择空位买入、准备和行动。房主开始每手。若 Bot 自己是房主，可加 `BOT_AUTO_START=true`，至少两人准备后自动开始。停止程序后原座位仍在；用 `stand` / `leave` 主动离座，或由房主踢出。断线期间按原有超时规则处理。
