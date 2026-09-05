import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('注册审核、密码修改和权限校验', { timeout: 15000 }, async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'junqi-auth-'));
 const child = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, PORT: '32149', ADMIN_KEY: 'test-key', ACCOUNTS_FILE: path.join(dir, 'accounts.json') }, stdio: 'pipe' });
 try {
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('server exited '+code))); });
  const call = async (route, body, headers = {}, method = 'POST') => {
   const res = await fetch('http://127.0.0.1:32149/api/' + route, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
   return { status: res.status, body: await res.json() };
  };
  const admin = { 'x-admin-key': 'test-key' }, credentials = { username: 'tester', password: 'abc12345' };
  assert.equal((await call('register', credentials)).status, 201);
  assert.equal((await call('register', credentials)).status, 409);
  assert.equal((await call('login', credentials)).status, 403);
  assert.equal((await call('admin/registrations', null, {}, 'GET')).status, 403);
  const pending = await call('admin/registrations', null, admin, 'GET');
  assert.equal(pending.body[0].username, 'tester'); assert.equal(pending.body[0].hash, undefined);
  assert.equal((await call('admin/registrations/tester', { action: 'approve' })).status, 403);
  assert.equal((await call('admin/registrations/tester', { action: 'approve' }, admin)).status, 200);
  const login = await call('login', credentials); assert.equal(login.status, 200);
  const headers = { Authorization: 'Bearer ' + login.body.token };
  assert.equal((await call('password', { oldPassword: 'incorrect', password: 'new12345' }, headers)).status, 403);
  assert.equal((await call('password', { oldPassword: credentials.password, password: 'new12345' }, headers)).status, 200);
  assert.equal((await call('password', { oldPassword: 'new12345', password: 'new23456' }, headers)).status, 401);
  assert.equal((await call('login', credentials)).status, 401);
  const renewed = await call('login', { ...credentials, password: 'new12345' });
  assert.equal(renewed.status, 200);
  const renewedHeaders = { Authorization: 'Bearer ' + renewed.body.token };
  assert.equal((await call('logout', null, renewedHeaders)).status, 200);
  assert.equal((await call('password', { oldPassword: 'new12345', password: 'new23456' }, renewedHeaders)).status, 401);
  const other = { username: 'rejected', password: 'abc12345' };
  await call('register', other);
  assert.equal((await call('admin/registrations/rejected', { action: 'reject' }, admin)).status, 200);
  assert.equal((await call('login', other)).status, 401);
  assert.equal((await call('register', other)).status, 201);
 } finally { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); await rm(dir, { recursive: true, force: true }); }
});
