import {readFile,writeFile} from 'node:fs/promises';
import {marked} from 'marked';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const passwordPage=await readFile(new URL('public/password.html',root),'utf8');
await writeFile(new URL('public/settings.html',root),passwordPage.replace('<title>修改密码','<title>设置').replace('<h1>修改密码</h1>','<h1>设置</h1><section><h2>提醒与显示</h2><div id="preference-options"></div><p id="preference-result" role="status"></p></section><section><h2>头像</h2><form id="avatar-form" class="avatar-form"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" required aria-label="选择头像"><button type="submit">保存头像</button></form><button id="reset-avatar" type="button">恢复默认头像</button><p>最大 4 MiB，显示时居中裁成正方形。更换或恢复默认时删除旧头像。</p><p id="avatar-result" role="status"></p></section><section><h2>修改密码</h2>').replace('</main>','</section></main>').replace('</body>','<script type="module" src="/settings.js"></script></body>'));
const page=(title,content,classes='document-shell')=>`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · 四国军棋</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/cf-layout.css"><link rel="icon" type="image/png" href="/favicon.png?v=240"></head>
<body><script type="module" src="/site-shell.js"></script><main class="${classes}">${content}</main><script type="module" src="/user-colors.js"></script></body></html>\n`;
for(const [source,target,title]of [['RULES.md','rules.html','规则'],['BOT_API.md','bot-api.html','API']]){
  const markdown=await readFile(new URL(source,root),'utf8');
  await writeFile(new URL('public/'+target,root),page(title,(source==='BOT_API.md'?'<p><a class="document-download" href="/BOT_API.md" download="BOT_API.md">下载 BOT_API.md 文档</a></p>':'')+marked.parse(markdown)));
}
await writeFile(new URL('public/login.html',root),page('登录',`<h1>登录</h1><form id="site-login-form"><label>账号<input class="text-input" name="username" minlength="2" maxlength="16" autocomplete="username" required></label><label>密码<input class="text-input" name="password" type="password" maxlength="64" autocomplete="current-password" required></label><button class="primary-button" type="submit">登录</button> <a href="/register.html">注册账号</a></form><p id="login-result" role="status"></p>`,'document-shell login-shell'));
await writeFile(new URL('public/bots.html',root),page('BOT 列表',`<h1>BOT 列表</h1><p><a href="/ratings.html?type=bot">BOT Rating 排名</a></p><div class="ranking-table-wrap"><table class="ranking-table"><thead><tr><th>账号</th><th>Rating</th><th>程序状态</th><th>占用位置</th></tr></thead><tbody id="bots-body"><tr><td colspan="4">正在加载…</td></tr></tbody></table></div>`,'ranking-shell'));
await writeFile(new URL('public/advertisement.html',root),page('广告',`<h1>广告</h1><p>本项目作者 <a href="https://www.luogu.com.cn/user/1659487">BitByBit</a> 喵</p><ul><li><a href="https://github.com/BitByBitG/siguo-junqi">GitHub 项目网址</a></li><li><a href="https://github.com/BitByBitG">GitHub 主页</a></li><li>QQ 交流群 630238775</li><li>关注 BitByBit 喵，给 BitByBit 点 star 喵，欢迎加群喵</li></ul>`));
console.log('Generated rules, API, login, BOT list and advertisement pages in '+fileURLToPath(new URL('public/',root)));
