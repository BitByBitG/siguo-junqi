import "/secure.js";
const $ = selector => document.querySelector(selector);
let auth;
try { auth = JSON.parse(localStorage.getItem('junqi-auth')); } catch {}
let busy = false;
async function api(route, method = 'GET', body) {
  const response = await fetch(route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth?.token || ''}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '请求失败');
  return data;
}
function message(text) { $('#program-status').textContent = text; }
async function refresh(initial = false) {
  const data = await api('/api/program');
  if (initial) $('#source').value = data.source || 'function act(state) {\n  if (state.phase === "setup") return { action: "ready", ready: true };\n  return { action: "move", ...state.legalMoves[0] };\n}\n';
  $('#running').textContent = data.enabled ? '● 托管运行中' : '○ 已停止';
  if(data.serverHostingAllowed===false)$('#running').textContent='× 管理员已禁止服务器托管';
  $('#save').disabled=data.serverHostingAllowed===false;$('#start').disabled=data.serverHostingAllowed===false;
  message(data.message || '粘贴自己的程序，然后保存并启动。');
}
async function action(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('.studio-toolbar button').forEach(b => b.disabled = true);
  try { await fn(); await refresh(); } catch (error) { message(error.message); }
  finally { busy = false; document.querySelectorAll('.studio-toolbar button').forEach(b => b.disabled = false); }
}
$('#save').onclick = () => action(() => api('/api/program', 'PUT', { source: $('#source').value }));
$('#start').onclick = () => action(async () => {
  await api('/api/program', 'PUT', { source: $('#source').value });
  await api('/api/program/run', 'POST', { enabled: true });
});
$('#stop').onclick = () => action(() => api('/api/program/run', 'POST', { enabled: false }));
(async () => {
  if (!auth?.token) { location.replace('/'); return; }
  try {
    const me = await api('/api/me');
    if (me.accountType !== 'bot') throw Error('请退出后使用已审核的 BOT 账号登录工作台。');
    $('#account').textContent = `当前 BOT 账号：${me.username}`;
    await refresh(true);
    setInterval(() => { if (!busy) refresh().catch(error => message(error.message)); }, 2500);
  } catch (error) { message(error.message); }
})();
