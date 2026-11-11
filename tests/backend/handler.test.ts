// 네트워크·실제 계정·인증값을 사용하지 않는 합성 경계 검사.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../src/server/handler.js';
import type { Backend, Environment } from '../../src/server/handler.js';

const env: Environment = {
  SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_NOT_A_REAL_KEY',
  APP_ENV: 'preview',
  ALLOWED_ORIGINS: 'https://frontend.invalid',
};
const backend: Backend = {
  getUser: async () => ({ id: 'synthetic-user', isAnonymous: false }),
  getProfile: async id => ({ user_id: id, revision: 0 }),
};
const req = (path: string, headers: Record<string,string> = {}, method = 'GET') =>
  new Request(`https://api.invalid${path}`, { method, headers });
const auth = { Authorization: 'Bearer SYNTHETIC_TEST_TOKEN' };

test('liveness does not claim a DB connection and works without secrets', async () => {
  const handler = createHandler({ env: {}, createBackend: () => { throw Error('must not connect'); } });
  const res = await handler(req('/api/health'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).database, undefined);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
test('profile and readiness require a bearer token before configuration access', async () => {
  const handler = createHandler({ env: {}, createBackend: () => backend });
  for (const path of ['/api/v1/me','/api/ready']) assert.equal((await handler(req(path))).status,401);
});
test('unlisted origins are rejected, exact origin receives CORS headers', async () => {
  const handler = createHandler({ env, createBackend: () => backend });
  assert.equal((await handler(req('/api/v1/me',{...auth, Origin:'https://evil.invalid'}))).status,403);
  const res = await handler(req('/api/v1/me',{...auth, Origin:'https://frontend.invalid'}));
  assert.equal(res.status,200);
  assert.equal(res.headers.get('access-control-allow-origin'),'https://frontend.invalid');
  assert.equal(res.headers.get('access-control-allow-credentials'),null);
});
test('missing config and development DB on production fail closed', async () => {
  for (const config of [{}, {...env, VERCEL_ENV:'production'}]) {
    const handler = createHandler({ env: config, createBackend: () => backend });
    assert.equal((await handler(req('/api/v1/me',auth))).status,503);
  }
});
test('invalid and anonymous sessions are rejected', async () => {
  for (const user of [null,{id:'synthetic-user',isAnonymous:true}]) {
    const handler = createHandler({ env, createBackend: () => ({...backend,getUser:async()=>user}) });
    assert.equal((await handler(req('/api/v1/me',auth))).status,401);
  }
});
test('validated identity selects its own profile', async () => {
  const handler = createHandler({ env, createBackend: () => backend });
  const res = await handler(req('/api/v1/me',auth));
  assert.equal(res.status,200);
  assert.equal((await res.json()).profile.user_id,'synthetic-user');
});
test('backend failure is unavailable and does not disclose error or token', async () => {
  const logs: unknown[]=[];
  const handler = createHandler({ env, createBackend: () => ({...backend,getProfile:async()=>{throw Error('SYNTHETIC_PRIVATE_DETAIL');}}),log:e=>logs.push(e) });
  const res = await handler(req('/api/ready',auth));
  assert.equal(res.status,503);
  assert.doesNotMatch(await res.text(),/SYNTHETIC/);
  assert.doesNotMatch(JSON.stringify(logs),/SYNTHETIC/);
});
test('unsupported methods and paths cannot execute data operations', async () => {
  const handler = createHandler({ env, createBackend: () => {throw Error('must not connect');} });
  assert.equal((await handler(req('/api/v1/me',auth,'POST'))).status,405);
  assert.equal((await handler(req('/api/other',auth))).status,404);
});
