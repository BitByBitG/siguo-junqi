# 四国军棋神经网络 BOT

这是通过本站 BOT API 运行的外部 PyTorch BOT。它使用图神经网络编码棋盘，策略头只在服务器给出的合法走法中选择，价值头估计当前局面对本方的胜率。每局结束后程序会用本局轨迹继续训练并保存模型。

## 安装

建议使用 Python 3.10 以上：

```bash
cd neural-bot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 运行

先在网站创建并审核 BOT 账号，再由房主把它加入房间。停止该账号在 BOT 工作台中的服务器托管，避免外部程序与托管程序争夺同一座位。

```bash
export BOT_SERVER='https://junqi.bitbybit.dpdns.org'
export BOT_USERNAME='你的 BOT 用户名'
read -s -p 'BOT 密码: ' BOT_PASSWORD; export BOT_PASSWORD
python neural_bot.py
```

## 本地自我对弈训练

在完整四国军棋项目的 `neural-bot` 目录中执行：

```bash
source .venv/bin/activate
python self_play.py --games 10000 --device cpu
```

有 NVIDIA CUDA 环境时可以使用：

```bash
python self_play.py --games 10000 --device cuda
```

训练器直接复用项目中的 `server/game.js`，不需要启动网站或连接网络。默认随机混合四方混战与对家结盟；也可以只训练一种模式：

```bash
python self_play.py --games 5000 --modes ffa
python self_play.py --games 5000 --modes alliance
```

训练进度和优化器状态保存到同一个 `model.pt`。训练中断后重复命令即可继续；随后运行 `neural_bot.py` 会自动加载它参加线上对局。建议先运行 100 局确认环境正常，再逐步增加到数万局。

同一 BOT 账号同时占多个位置时，程序会让每个位置独立决策，并共享一个模型。默认模型保存为 `model.pt`。常用参数：

```bash
python neural_bot.py --model model.pt --device cpu
python neural_bot.py --inference-only
python neural_bot.py --temperature 0.8
```

本地 HTTPS 使用自签名证书时，不要关闭证书校验。把 mkcert 根证书交给 Requests：

```bash
export REQUESTS_CA_BUNDLE='/path/to/rootCA.pem'
```

刚创建的模型尚未训练，强度主要来自规则先验。它需要积累大量真人或自我对弈局数才会逐渐形成有效策略；仅仅使用神经网络结构不会自动变强。
