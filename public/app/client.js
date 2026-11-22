// 사용자 세션으로 공고 목록과 본인 실행을 읽는다. 공급자 응답의 원문은 화면에 노출하지 않는다.
let clientPromise;
let sdkPromise;
const inFlight = new Map();
const pendingKeys = new Map();
const intentPrefix = 'homecierge.directory-request.';
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const noticeConflicts = new Set([
  'notice_index_not_ready',
  'notice_not_found',
  'notice_source_conflict',
  'notice_kind_unsupported',
  'notice_edition_mismatch',
  'notice_edition_unverified',
  'notice_model_not_found',
  'notice_model_unverified',
  'notice_region_unverified',
  'analysis_notice_selection_conflict',
]);
const publicErrors = new Set([
  ...noticeConflicts,
  'authentication_required',
  'configuration_unavailable',
  'search_index_not_ready',
  'search_source_restricted',
  'directory_page_changed',
  'invalid_directory_input',
  'invalid_run_input',
  'notice_source_restricted',
  'run_rate_limited',
  'run_not_found',
  'run_conflict',
  'comparison_not_available',
  'comparison_source_restricted',
  'backend_unavailable',
]);

function apiError(code) {
  return Object.assign(new Error(code), { code });
}

function authError(error) {
  const code = error?.code;
  if (
    [
      'invalid_credentials',
      'email_not_confirmed',
      'weak_password',
      'signup_disabled',
      'user_already_exists',
      'email_address_invalid',
    ].includes(code)
  )
    return apiError(code);
  if (error?.status === 429 || ['over_request_rate_limit', 'over_email_send_rate_limit'].includes(code))
    return apiError('auth_rate_limited');
  return apiError('backend_unavailable');
}

function loadSdk() {
  if (globalThis.supabase?.createClient) return Promise.resolve(globalThis.supabase);
  if (!sdkPromise)
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/supabase.js';
      script.async = true;
      const failed = () => {
        script.remove();
        reject(apiError('configuration_unavailable'));
      };
      script.onload = () => (globalThis.supabase?.createClient ? resolve(globalThis.supabase) : failed());
      script.onerror = failed;
      document.head.append(script);
    }).catch((error) => {
      sdkPromise = undefined;
      throw error;
    });
  return sdkPromise;
}

async function connect() {
  const response = await fetch('/api/v1/client-config', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw apiError('configuration_unavailable');
  const config = await response.json();
  const url = new URL(config.supabaseUrl);
  if (
    !/^sb_publishable_[\w-]+$/.test(config.publishableKey) ||
    url.origin !== config.supabaseUrl ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  ) {
    throw apiError('configuration_unavailable');
  }
  const sdk = await loadSdk();
  return sdk.createClient(url.origin, config.publishableKey);
}

function client() {
  if (!clientPromise)
    clientPromise = connect().catch(() => {
      clientPromise = undefined;
      throw apiError('configuration_unavailable');
    });
  return clientPromise;
}

function identity(session) {
  const user = session?.user;
  return user && !user.is_anonymous && uuid.test(user.id) ? { id: user.id, email: user.email ?? '' } : null;
}

async function currentSession() {
  const { data, error } = await (await client()).auth.getSession();
  if (error) throw authError(error);
  return data.session;
}

export async function getSession() {
  return identity(await currentSession());
}

export async function signIn(email, password) {
  const { data, error } = await (await client()).auth.signInWithPassword({ email, password });
  if (error) throw authError(error);
  const user = identity(data.session);
  if (!user) throw apiError('authentication_required');
  return user;
}

export async function signUp(email, password) {
  const { data, error } = await (
    await client()
  ).auth.signUp({ email, password, options: { emailRedirectTo: new URL('/', location.origin).href } });
  if (error) throw authError(error);
  return { signedIn: Boolean(identity(data.session)), email };
}

export async function signOut() {
  const { error } = await (await client()).auth.signOut({ scope: 'local' });
  if (error) throw authError(error);
  pendingKeys.clear();
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(intentPrefix)) sessionStorage.removeItem(key);
  } catch {
    /* 브라우저가 임시 저장소를 차단한 경우 메모리 키만 사용한다. */
  }
}

export function onSessionChange(callback) {
  let active = true;
  let subscription;
  void client()
    .then((sdk) => {
      if (!active) return;
      subscription = sdk.auth.onAuthStateChange((_event, session) => {
        // 세션 잠금이 해제된 뒤 화면이 목록 RPC를 요청할 수 있게 한다.
        setTimeout(() => {
          if (active) callback(identity(session));
        }, 0);
      }).data.subscription;
    })
    .catch(() => {});
  return () => {
    active = false;
    subscription?.unsubscribe();
  };
}

async function request(path, method = 'GET') {
  const session = await currentSession();
  if (!identity(session)) throw apiError('authentication_required');
  let response, data;
  try {
    response = await fetch(path, {
      method,
      headers: { Authorization: 'Bearer ' + session.access_token },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    data = await response.json();
  } catch {
    throw apiError('backend_unavailable');
  }
  if (!response.ok) throw apiError(publicErrors.has(data?.error) ? data.error : 'backend_unavailable');
  return data;
}

export function listNotices({ limit, cursor, includeClosed } = {}) {
  const query = new URLSearchParams();
  if (limit != null) query.set('limit', String(limit));
  if (cursor != null) query.set('cursor', cursor);
  if (includeClosed != null) query.set('includeClosed', String(includeClosed));
  return request('/api/v1/notices?' + query);
}

function databaseError(error) {
  if (error?.code === 'PT403') return apiError('notice_source_restricted');
  if (error?.code === 'PT409')
    return apiError(noticeConflicts.has(error.message) ? error.message : 'run_conflict');
  if (error?.code === 'PT429') return apiError('run_rate_limited');
  if (error?.code === 'PT404') return apiError('run_not_found');
  if (error?.code === '22023') return apiError('invalid_run_input');
  if (['42501', 'PGRST301', 'PGRST303'].includes(error?.code)) return apiError('authentication_required');
  return apiError('backend_unavailable');
}

export async function listAnalyses() {
  const owner = await getSession();
  if (!owner) throw apiError('authentication_required');
  const { data, error } = await (
    await client()
  )
    .from('analyses')
    .select('id,latest_run_id,title,status,updated_at')
    .eq('user_id', owner.id)
    .not('latest_run_id', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(30);
  if (error) throw databaseError(error);
  return data.map((row) => ({
    analysisId: row.id,
    runId: row.latest_run_id,
    title: row.title,
    status: row.status,
    updatedAt: row.updated_at,
  }));
}

function rememberRequest(name) {
  let key = pendingKeys.get(name);
  try {
    key ??= sessionStorage.getItem(name);
  } catch {
    /* 메모리에서 재시도한다. */
  }
  if (!uuid.test(key)) key = crypto.randomUUID();
  pendingKeys.set(name, key);
  try {
    sessionStorage.setItem(name, key);
  } catch {
    /* 현재 탭의 메모리 키를 유지한다. */
  }
  return key;
}
function forgetRequest(name) {
  pendingKeys.delete(name);
  try {
    sessionStorage.removeItem(name);
  } catch {
    /* 메모리 키를 이미 지웠다. */
  }
}

export async function startAnalysis(notice, model) {
  const proposed = model?.analysisInput;
  if (
    !proposed ||
    proposed.kind !== 'notice' ||
    proposed.houseManageNo !== notice?.houseManageNo ||
    proposed.noticeNo !== notice?.noticeNo ||
    proposed.edition !== notice?.edition ||
    proposed.modelNo !== model.modelNo ||
    !['applyhome_apt', 'applyhome_remainder'].includes(proposed.noticeSource)
  )
    throw apiError('invalid_run_input');
  const { kind, noticeSource, houseManageNo, noticeNo, edition, modelNo } = proposed;
  const input = { kind, noticeSource, houseManageNo, noticeNo, edition, modelNo };
  const owner = await getSession();
  if (!owner) throw apiError('authentication_required');
  const name = intentPrefix + [owner.id, noticeSource, houseManageNo, noticeNo, edition, modelNo].join('/');
  if (inFlight.has(name)) return inFlight.get(name);
  const key = rememberRequest(name);
  const task = (async () => {
    const { data, error } = await (
      await client()
    ).rpc('start_notice_workspace', { p_request_key: key, p_input: input });
    if (error) {
      const mapped = databaseError(error);
      if (mapped.code !== 'backend_unavailable' && mapped.code !== 'run_rate_limited') forgetRequest(name);
      throw mapped;
    }
    if (
      !uuid.test(data?.analysisId) ||
      !uuid.test(data?.runId) ||
      !Object.keys(input).every((field) => data?.input?.[field] === input[field])
    )
      throw apiError('backend_unavailable');
    forgetRequest(name);
    return data;
  })().finally(() => inFlight.delete(name));
  inFlight.set(name, task);
  return task;
}

function runPath(analysisId, runId) {
  if (!uuid.test(analysisId) || !uuid.test(runId)) throw apiError('invalid_run_input');
  return '/api/v1/analyses/' + analysisId + '/runs/' + runId;
}
export function getRun(analysisId, runId) {
  return request(runPath(analysisId, runId));
}
export function cancelRun(analysisId, runId) {
  return request(runPath(analysisId, runId) + '/cancel', 'POST');
}
export function getResult(analysisId, runId) {
  return request(runPath(analysisId, runId) + '/result');
}
