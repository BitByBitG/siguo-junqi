import '/secure.js';
import {colorRating} from './rating-colors.js';
let profiles = new Map(), pattern, pending = false;
function paint() {
  pending = false;
  if (!pattern) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement.closest('script,style,textarea,input,select,svg,code,pre,.katex,.cf-rated,.chat-content,[contenteditable]')) nodes.push(node);
  }
  for (const node of nodes) {
    pattern.lastIndex = 0;
    const matches = [...node.data.matchAll(pattern)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment(); let end = 0;
    for (const match of matches) {
      fragment.append(node.data.slice(end, match.index));
      const span = colorRating(document.createElement(node.parentElement.closest('a,button')?'span':'a'), profiles.get(match[0]).rating);
      if(span.tagName==='A')span.href='/profile/'+encodeURIComponent(match[0]);
      span.textContent = match[0]; span.dataset.username = match[0]; fragment.append(span);
      end = match.index + match[0].length;
    }
    fragment.append(node.data.slice(end)); node.replaceWith(fragment);
  }
}
function schedule() { if (!pending) { pending = true; requestAnimationFrame(paint); } }
async function refresh() {
  try {
    const response = await fetch('/api/profiles'); if (!response.ok) return;
    const accounts = await response.json(); profiles = new Map(accounts.map(a => [a.username, a]));
    const names = [...profiles.keys()].sort((a,b) => b.length-a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    pattern = names.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${names.join('|')})(?![A-Za-z0-9_])`, 'gu') : null;
    document.querySelectorAll('[data-username]').forEach(el => {const p = profiles.get(el.dataset.username); if(p) colorRating(el,p.rating);});
    schedule();
  } catch { /* The next login or profile update retries. */ }
}
new MutationObserver(schedule).observe(document.body, {childList:true, subtree:true, characterData:true});
window.addEventListener('junqi-profile-refresh', refresh);
refresh();
async function heartbeat() {
  try {
    const token = JSON.parse(localStorage.getItem('junqi-auth') || 'null')?.token;
    if (token) await fetch('/api/presence', {method:'POST', headers:{Authorization:`Bearer ${token}`}});
  } catch { /* Retry after reconnect. */ }
}
heartbeat();
setInterval(heartbeat, 15000);
window.addEventListener('junqi-profile-refresh', heartbeat);
window.addEventListener('storage', heartbeat);
