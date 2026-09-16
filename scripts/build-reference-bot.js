import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputs = ['server/game.js', 'bots/engine/bot.js', 'bots/engine/search.js', 'bots/secure-client.js', 'bots/client-runtime.js'];
const source = inputs.map(name => fs.readFileSync(path.join(root, name), 'utf8')
  .replace(/^import .* from ['"]\.[^'"]+['"];\r?\n/gm, '')).join('\n');
const output = '// Standalone Junqi BOT; Node.js 18+, no npm dependencies. Generated from this project.\n' + source;
fs.writeFileSync(path.join(root, 'bots/siguo-junqi-bot.mjs'), output);
console.log('Built bots/siguo-junqi-bot.mjs');
const hosted = inputs.slice(0, 3).map(name => fs.readFileSync(path.join(root, name), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')).join('\n');
fs.writeFileSync(path.join(root, 'public/bot-studio-bot.js'), `// 可直接粘贴到 BOT 工作台的四国军棋 BOT。无需 import、require 或网络权限。
const crypto = { randomUUID: () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) };
` + hosted + `
function act(state) {
  if (state.phase === 'setup') {
    if (state.programPrepared) return { action: 'ready', ready: true };
    const army = createStrongArmy(state.viewerSeat, 200);
    const slots = new Map(Object.keys(PIECE_INFO).map(t => [t, army.filter(p => p.type === t).map(p => p.position)]));
    return { action: 'setup', pieces: state.pieces.filter(p => p.owner === state.viewerSeat).map(p => ({ id: p.id, position: slots.get(p.type).pop() })) };
  }
  const history = state.memory?.history || [];
  const move = chooseStrongMove(state, history, { budgetMs: Math.min(3500,state.thinkTimeMs||3500) }).move || state.legalMoves[0];
  return { action: 'move', ...move, memory: { history: [...history, move].slice(-16) } };
}
`);
console.log('Built public/bot-studio-bot.js');
