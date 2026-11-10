# 德州扑克 / Texas Hold’em

这是军棋网站内的免费娱乐模式。没有独立注册或密码，也没有独立服务器；继续运行原有 `npm start`，沿用已有端口、HTTPS 和隧道配置。

## 开通与进入

1. 更新代码、重启服务并刷新浏览器。
2. 管理员进入 `admin.html` 的「德州扑克」，加载账号，选择玩家并「开通德州扑克权限」。管理员自己的账号也需要开通才能参加。
3. 已开通账号右上方导航出现「德州扑克」，访问 `/holdem/contest` 创建或进入牌桌。未授权直接访问页面只显示提示，接口拒绝请求。机器人账号不支持。
4. 权限存在原账号文件的 `holdemEnabled` 字段，原账号缺省关闭。撤权立即离座弃牌，后续请求拒绝；全站封禁与分组暂停也有效。每日建房额度与军棋共用。

## 界面与规则

德州扑克页面使用独立扑克牌图标、标题及导航：四国军棋、比赛、排名、规则。点击顶部标识返回扑克比赛页。规则移至 `/holdem/rules`，支持中英文切换；账号设置、主题、语言切换仍共用原系统。

## 牌局

支持 2–9 人、观战、盲注、四轮下注、全下、边池、平分和奇数筹码分配。超时可过牌则过牌，否则弃牌。对局中客户端仅接收自身底牌；每手结束后公开所有参赛者手牌，包括弃牌、离座和直接获胜的玩家；管理员结束当前手牌也会公开。下一手开始后重新隐藏。刷新或重启后可以重新进入原桌。多人同时操作用手数、行动位和版本号校验，旧请求不能重复下注。

筹码按账号永久保存。默认初始 10000、每日 2000，管理员可修改；初始金额仅首次开通生效，每日金额从下一个北京时间零点生效，停机期间的应发额度会在启动后补齐，停用期间不发放。买入扣除可用余额，离座结算后退还；禁止借贷和负数，不再自动补充牌桌筹码。`/holdem/contest` 显示牌桌，`/holdem/ratings` 显示筹码排名（包含可用、牌桌及下注筹码）。没有充值、提现、筹码转让、付费买入或现实奖励。禁止现金赌博、支付招揽和线下结算。不参与军棋等级分计算。

## 聊天和后台

沿用军棋的 Markdown/LaTeX 渲染、十行折叠、源码复制、图床及图片缓存、头像、时间、表情回应、提及提醒和放大聊天。房主可踢人、禁言和删除消息；自己的消息五分钟内可撤回。每桌保留最多 100 条聊天。

后台可批量开通/停用权限、结束当前手牌（退还本手投入并公开本手底牌）、删除牌桌、清空聊天，并在不进桌的情况下管理聊天。军棋与德州扑克管理分开。筹码可单选、多选或全选当前筛选结果增发，账号列表不分页；发放有记录，重复提交同一请求不重复发放。

账号权限与原账号数据一起保存；牌桌、完整内部牌局状态和聊天保存在账号数据目录的 `holdem-rooms.json`，原子写入。这个文件含私有底牌和牌堆，不要放进公共目录或 Git。首次启动没有这个文件会创建；原军棋存档和图床不迁移、不删除。

## English

Enable player access in Administration → Texas Hold’em. Existing accounts are disabled by default, including administrators; bots cannot participate. Use `/holdem` and `/holdem/room/ID`. Login, encrypted transport, themes, language and chat rendering are shared with Junqi. Access is enforced server-side and revocation removes the player's seats. Account chips persist; initial and daily grants are configurable in the separate Hold’em administration tab. Daily grants use Beijing midnight. Buy-ins debit the wallet; settled departures return chips. See `/holdem/contest` and `/holdem/ratings`, with no deposits, withdrawals, transfers or prizes. Hold’em never changes Junqi ratings. Back up `holdem-rooms.json` alongside the existing account data; it contains private game state and must not be published.
