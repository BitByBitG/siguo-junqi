# 斗地主 / Dou Dizhu

入口 `/ddz` 或 `/ddz/contest`，积分排名 `/ddz/ratings`，规则 `/ddz/rules`，房间 `/ddz/room/ID`。

所有正常玩家账号默认可玩，无需单独授权。机器人账号不支持。沿用军棋账号、加密传输、头像、聊天、图床、深浅主题和中英文切换；三个游戏导航互相提供入口，德州扑克入口仍仅对已开通用户显示。

## 玩法

- 三人54张，每人17张、底牌3张；四人108张，每人25张、底牌8张。坐满且全部准备后房主开局。
- 随机首家，轮流不叫或叫1/2/3分；只能叫更高分，3分直接确定地主，全不叫重新发牌。三人底牌公开，四人不展示独立底牌区域，8张直接加入地主手牌，地主拿底牌先出。
- 三人支持常见单、对、三张、三带一/对、顺子、连对、飞机及单/对翅膀、四带两单/两对、四张炸弹、双王王炸。
- 四人仅三带对、飞机不带或带对，不允许三带一、飞机带单和四带二；4～8张同点炸弹先比张数后比点数，四王王炸最大；同色王可作对子，一大一小不能作对子或王炸。
- 2与王不能进连续牌型，翅膀不能与主体同点，对翅膀点数各异，不能把四张拆成两对翅膀。
- 自己领出不能不要；其他所有人不要后回到最后出牌者自由领出。
- 叫分、出牌均无时限，不会自动叫分、出牌或不要。断线保留手牌，重连继续；进行中不能离座、离开或被踢。无人能继续时可由管理员取消本局。
- 地主出完则地主赢，任一农民出完则全体农民赢。结束公开所有剩余手牌。

## 积分

独立累计积分从0开始，可负数，不影响军棋等级分和德州筹码。

每位农民的单位分为 `S = 叫分 × min(64, 1 + 打出炸弹数 + 王炸数 + 春天次数)`。

地主胜则每位农民扣S，地主加 `(人数−1)×S`；农民胜反过来。地主赢且所有农民没出过牌为春天；农民赢且地主只出过一次为反春天，单局最多一种。所有积分变化之和为0。

## 管理与存档

`admin.html → 斗地主管理` 可单个或批量取消当前局、删除房间、清空聊天，也可管理禁言和删除消息。取消、关闭不计分。每个聊天室保留100条，沿用群组限制、每日建房额度、封禁与全站禁言。

账号数据目录新增 `ddz-rooms.json`，同时原子保存牌局、积分和聊天。请与原账号数据一起备份，文件含完整手牌，不要公开或上传Git。旧存档不迁移、不删除；继续使用原 `npm start` 和端口，无需新增依赖。

## English

Dou Dizhu shares existing accounts and is enabled for all normal human players. Use `/ddz/contest`, `/ddz/ratings` and `/ddz/rules`. Three players use one 54-card deck; four players use two decks with 8 private bottom cards. See the bilingual Rules page for bidding, supported patterns, unlimited thinking time and scoring. Scores start at 0, may be negative, and are independent of Junqi ratings and Hold’em chips. The multiplier is capped at 64. Administration has a separate Dou Dizhu tab. Back up `ddz-rooms.json` with account data; it contains private hands and must not be published. No cash, purchases, withdrawals, transfers or real-world rewards.

房主可在等待或结算后修改3/4人模式，修改后全员取消准备。四改三前须先腾空第四座位；对局进行中不可修改。

## 交互与公共组件（2.12.0）

- 白底牌桌，点数与花色位于牌上部；手牌按点数降序分列，同点数错层排列。对手在上方，自己在下方，名字旁显示最近出的牌或“不要”。
- 不合法、空选择、压不过上家或未轮到自己时出牌禁用；跳过使用单独的“不要”操作。
- 下家行动前可撤回自己的出牌，已结算不可撤回；记牌器和最近操作同时回滚。
- 记牌器由全副牌减去公开已出的牌计算，包含自己的未出手牌，不读取暗牌。
- 与军棋共用表情选择器、浮动提示、玩家卡片状态及积分变化样式。扑克房间显示观战名单和在线状态，观战者不能读暗牌。
- 结算后左侧玩家卡片显示分差，结算表显示分差和累计积分。

2.12.1：倍率改为加法累计，基础1倍，每个炸弹/王炸/春天加1，最高64倍。后台用户列表不分页，斗地主管理可单个/批量/全选设置累计积分（可负数），不改变军棋等级分或德州筹码。
