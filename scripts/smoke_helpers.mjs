// 실제 Supabase Auth 통합 검수 스크립트들이 공유하는 합성 자료·격리·정리 보조 함수.
// 외부 API(청약홈·실거래·카카오·OpenAI·네이버)를 호출하지 않으며 사용자 요청은 항상 사용자 JWT만 사용한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../', import.meta.url);
const PYTHON_ENV = { PATH: process.env.PATH, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
const UPLOAD_BUCKET = 'analysis-uploads';

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isLoopbackOrigin(origin) {
  return ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
}

export function koreaDate(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(date);
}

export function requestJson(requestApi, path, { token, method = 'GET', body, headers = {} } = {}) {
  const merged = { ...headers };
  if (token) merged.Authorization = `Bearer ${token}`;
  if (body !== undefined) merged['Content-Type'] = 'application/json';
  return requestApi(path, {
    method,
    headers: merged,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function expectJson(reply, status, check, step) {
  check(reply.status === status, `${step}_status`);
  try {
    return await reply.json();
  } catch {
    check(false, `${step}_json`);
  }
}

export function checkNoStore(reply, check, step) {
  const directives = (reply.headers.get('cache-control') ?? '').toLowerCase().split(',');
  check(directives.some(value => value.trim() === 'no-store'), `${step}_no_store`);
}

export function checkServiceOnlyDenied(check, response, step) {
  check((response.status === 403 && response.error?.code === '42501')
    || (response.status === 404 && response.error?.code === 'PGRST202'), step);
}

export function checkRpcError(check, response, codes, step) {
  const allowed = Array.isArray(codes) ? codes : [codes];
  check(Boolean(response.error) && allowed.includes(response.error.code), step);
}

export async function runPythonJson(program, payload, check, step, timeout = 30_000) {
  let stdout;
  try {
    const child = execFileAsync('python3', ['-B', '-c', program], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: PYTHON_ENV,
    });
    if (payload !== undefined) {
      child.child.stdin.end(JSON.stringify(payload));
    } else {
      child.child.stdin.end();
    }
    ({ stdout } = await child);
  } catch {
    check(false, `${step}_python`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    check(false, `${step}_python_json`);
  }
}

// 로컬 격리 Supabase(loopback)에서만 source_registry 행을 준비하고 종료 시 수정한 기존 행을 원복한다.
// 호스팅 개발 프로젝트(homecierge-dev)에서는 공유 source_registry를 변경하지 않는다.
export async function withLoopbackSources(admin, origin, specs, check, result, step, action) {
  if (!isLoopbackOrigin(origin)) {
    return action();
  }
  const ids = specs.map(spec => spec.id);
  const priorRows = result(
    await admin.from('source_registry')
      .select('id,display_name,storage_permission,reuse_permission,display_permission,llm_permission,export_permission,retention_days')
      .in('id', ids),
    `${step}_read_sources`,
  );
  const priorById = new Map(priorRows.map(row => [row.id, row]));
  const toUpsert = specs.map(spec => {
    const existing = priorById.get(spec.id);
    return {
      id: spec.id,
      display_name: existing?.display_name ?? spec.display_name ?? `합성 검수 출처 (${spec.id})`,
      storage_permission: spec.storage_permission ?? existing?.storage_permission ?? 'allowed',
      reuse_permission: spec.reuse_permission ?? existing?.reuse_permission ?? 'allowed',
      display_permission: spec.display_permission ?? existing?.display_permission ?? 'allowed',
      llm_permission: spec.llm_permission ?? existing?.llm_permission ?? 'unknown',
      export_permission: spec.export_permission ?? existing?.export_permission ?? 'allowed',
      retention_days: spec.retention_days !== undefined ? spec.retention_days : null,
    };
  });
  result(await admin.from('source_registry').upsert(toUpsert, { onConflict: 'id' }), `${step}_seed_sources`);
  try {
    return await action();
  } finally {
    for (const prior of priorRows) {
      const restored = await admin.from('source_registry').update({
        display_name: prior.display_name,
        storage_permission: prior.storage_permission,
        reuse_permission: prior.reuse_permission,
        display_permission: prior.display_permission,
        llm_permission: prior.llm_permission,
        export_permission: prior.export_permission,
        retention_days: prior.retention_days,
      }).eq('id', prior.id);
      check(!restored.error, `${step}_restore_sources`);
    }
  }
}

export async function nextFreshObservedAt(userClient, rpcNames) {
  let maxMs = Date.now();
  for (const rpcName of rpcNames) {
    const reply = await userClient.rpc(rpcName);
    const ts = reply.data?.observedAt;
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed) && parsed >= maxMs) {
        maxMs = parsed + 1000;
      }
    }
  }
  return new Date(maxMs);
}

export async function registerScopedUpload(client, userId, analysisId, pdf, check, result, step, { storeFile = true } = {}) {
  const id = randomUUID();
  const path = `${userId}/${analysisId}/${id}.pdf`;
  const row = result(
    await client.rpc('register_analysis_upload', { analysis_id: analysisId, upload_id: id }).single(),
    `${step}_register`,
  );
  check(row?.id === id && row.object_path === path && row.status === 'registered', `${step}_registered`);
  if (storeFile) {
    const uploaded = result(
      await client.storage.from(UPLOAD_BUCKET).upload(path, pdf, {
        cacheControl: '0',
        contentType: 'application/pdf',
        upsert: false,
      }),
      `${step}_upload`,
    );
    check(uploaded?.path === path, `${step}_uploaded_path`);
  }
  return { id, analysisId, path, delegated: false, finalized: false, stored: storeFile };
}

export async function cleanUpScopedUploads(client, uploads, check, result, step) {
  for (const upload of uploads) {
    if (!upload || upload.delegated || upload.finalized) continue;
    const req = await client.rpc('request_analysis_upload_deletion', {
      analysis_id: upload.analysisId,
      upload_id: upload.id,
    }).single();
    if (req.error?.code === 'P0002') {
      upload.finalized = true;
      continue;
    }
    const row = result(req, `${step}_cleanup_request`);
    if (row?.status === 'deleted') {
      upload.finalized = true;
      continue;
    }
    if (upload.stored) {
      result(await client.storage.from(UPLOAD_BUCKET).remove([upload.path]), `${step}_cleanup_storage`);
    }
    const done = result(
      await client.rpc('finalize_analysis_upload_deletion', {
        analysis_id: upload.analysisId,
        upload_id: upload.id,
      }).single(),
      `${step}_cleanup_finalize`,
    );
    check(done?.status === 'deleted', `${step}_cleanup_deleted`);
    upload.finalized = true;
  }
}

export async function checkAccountCleanupZero(admin, accounts, check, result, step = 'cleanup') {
  if (!accounts.length) return;
  const userIds = accounts.map(account => account.id);
  const tables = [
    ['user_profiles', 'user_id'],
    ['chats', 'user_id'],
    ['chat_messages', 'user_id'],
    ['analyses', 'user_id'],
    ['analysis_input_snapshots', 'user_id'],
    ['reports', 'user_id'],
    ['funding_entries', 'user_id'],
    ['profile_change_requests', 'user_id'],
  ];
  for (const [table, column] of tables) {
    const rows = result(
      await admin.from(table).select(column).in(column, userIds),
      `${step}_${table}_read`,
    );
    check(rows.length === 0, `${step}_${table}_zero`);
  }
  for (const account of accounts) {
    const gone = await admin.auth.admin.getUserById(account.id);
    check(gone.error?.status === 404, `${step}_auth_zero`);
  }
}
