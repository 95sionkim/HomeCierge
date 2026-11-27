// 설정 오류가 실제 연결이나 입력값 출력으로 이어지지 않는지 검사한다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const cwd = new URL('../../', import.meta.url);
const blockFetch = `data:text/javascript,${encodeURIComponent(`
  globalThis.fetch = () => {
    process.stderr.write('UNEXPECTED_SYNTHETIC_FETCH\\n');
    throw new Error('UNEXPECTED_SYNTHETIC_FETCH');
  };
`)}`;
const syntheticEnv = {
  PATH: process.env.PATH,
  APP_ENV: 'development',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_NOT_A_REAL_KEY',
  SUPABASE_WORKER_KEY: 'sb_secret_SYNTHETIC_NOT_A_REAL_KEY',
};

test('BE-03 smoke fails before HTTP on production and other unapproved targets', () => {
  const cases = [
    { env: { APP_ENV: 'production' }, step: 'development_only' },
    { env: { VERCEL_ENV: 'production' }, step: 'development_only' },
    { env: { SUPABASE_URL: 'https://another-project.supabase.co' }, step: 'target_not_allowed' },
    { env: { SUPABASE_URL: 'http://127.0.0.1:54321/?secret=SYNTHETIC' }, step: 'target_not_allowed' },
    { env: { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_SYNTHETIC_WRONG_KEY' }, step: 'publishable_key_required' },
  ];
  for (const { env, step } of cases) {
    const smoke = spawnSync(process.execPath, [
      '--import', 'tsx', '--import', blockFetch, 'scripts/smoke_be03_auth.mjs',
    ], { cwd, encoding: 'utf8', env: { ...syntheticEnv, ...env }, timeout: 10_000 });
    assert.equal(smoke.status, 1);
    assert.equal(smoke.stdout, '');
    assert.equal(smoke.stderr, `BE-03 smoke failed (${step})\n`);
  }
});
