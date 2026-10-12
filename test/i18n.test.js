import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {translateText} from '../public/i18n.js';
test('Chinese interface replaces legacy English labels',()=>{
  assert.equal(translateText('BOT Rating 排名'),'机器人等级分排名');
  assert.equal(translateText('unrated'),'未评级');
});
test('English uses Junqi and translates navigation/actions',()=>{
  assert.equal(translateText('四国军棋','en'),'Junqi');
  assert.equal(translateText('申请和棋','en'),'Offer Draw');
  assert.equal(translateText('已禁言：','en'),'Muted:');
  assert.equal(translateText(' 保存并启动 ','en'),' Save & Start ');
});
test('translation does not change unknown protocol/source strings',()=>{
  assert.equal(translateText('function act(state) { return null; }','en'),'function act(state) { return null; }');
  assert.equal(translateText('north-0-0','en'),'north-0-0');
});
test('English rules and API documents exist and keep protocol fields',async()=>{
  const rules=await readFile(new URL('../public/locales/en/rules.html',import.meta.url),'utf8');
  const api=await readFile(new URL('../public/locales/en/bot-api.html',import.meta.url),'utf8');
  assert.match(rules,/Junqi Rules/);assert.match(api,/assignmentId/);assert.match(api,/server-v1/);
});
