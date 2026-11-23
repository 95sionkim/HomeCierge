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
  'invalid_search_input',
  'invalid_funding_input',
  'funding_not_found',
  'invalid_legal_input',
  'legal_evidence_not_found',
  'invalid_commute_input',
  'commute_snapshot_not_found',
  'commute_rate_limited',
  'invalid_news_input',
  'news_snapshot_not_found',
  'news_rate_limited',
  'invalid_run_input',
  'notice_source_restricted',
  'run_rate_limited',
  'run_not_found',
  'run_conflict',
  'comparison_not_available',
  'comparison_source_restricted',
  'invalid_conversation_input',
  'conversation_period_unavailable',
  'conversation_conflict',
  'backend_unavailable',
]);

function apiError(code, status = null) {
  return Object.assign(new Error(code), { code, ...(status == null ? {} : { status }) });
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

async function request(path, method = 'GET', body, signal) {
  const session = await currentSession();
  if (!identity(session)) throw apiError('authentication_required');
  let response, data;
  try {
    response = await fetch(path, {
      method,
      headers: { Authorization: 'Bearer ' + session.access_token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    data = await response.json();
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw apiError('backend_unavailable');
  }
  if (!response.ok) throw apiError(publicErrors.has(data?.error) ? data.error : 'backend_unavailable', response.status);
  return data;
}

export function listNotices({ limit, cursor, includeClosed } = {}) {
  const query = new URLSearchParams();
  if (limit != null) query.set('limit', String(limit));
  if (cursor != null) query.set('cursor', cursor);
  if (includeClosed != null) query.set('includeClosed', String(includeClosed));
  return request('/api/v1/notices?' + query);
}

export function listSearchRegions() {
  return request('/api/v1/notices/regions');
}

export function searchNotices(conditions) {
  return request('/api/v1/notices/search', 'POST', conditions);
}

export function readFundingPlan(analysisId, snapshotId, modelNo, room) {
  if (!uuid.test(analysisId) || !uuid.test(snapshotId)) throw apiError('invalid_funding_input');
  return request('/api/v1/analyses/' + analysisId + '/funding-plan', 'POST', { snapshotId, modelNo, room });
}

export function readSnapshotReference(section, analysisId, snapshotId, signal) {
  const law = section === 'law';
  if ((!law && section !== 'news') || !uuid.test(analysisId) || !uuid.test(snapshotId))
    throw apiError(law ? 'invalid_legal_input' : 'invalid_news_input');
  const service = law ? 'legal-evidence' : 'regional-news';
  return request(`/api/v1/analyses/${analysisId}/snapshots/${snapshotId}/${service}`,
    law ? 'GET' : 'POST', undefined, signal);
}

export function queryCommute(analysisId, snapshotId, destination, signal) {
  if (!uuid.test(analysisId) || !uuid.test(snapshotId)) throw apiError('invalid_commute_input');
  return request(`/api/v1/analyses/${analysisId}/snapshots/${snapshotId}/commute`, 'POST', { destination }, signal);
}

export async function commuteProfile(ownerId, signal) {
  const { data, error } = await (await client()).from('user_profiles').select('revision,commute_destination')
    .eq('user_id', ownerId).abortSignal(signal).maybeSingle();
  if (error) throw databaseError(error);
  if (data && (!Number.isSafeInteger(data.revision) || data.revision < 0 ||
      (data.commute_destination !== null && typeof data.commute_destination !== 'string'))) throw apiError('backend_unavailable');
  return data ?? { revision: 0, commute_destination: null };
}

export async function confirmDestination(ownerId, revision, destination) {
  const { error } = await (await client()).rpc('confirm_commute_destination', {
    p_user_id: ownerId, p_base_revision: revision, p_destination: destination,
  });
  if (error?.code === '40001') throw apiError('profile_changed');
  if (error) throw databaseError(error);
}

const profileMonth = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/;
const profilePatterns = {
  budget_max_won: /^(?:0|[1-9][0-9]*)$/,
  supply_area_min_m2: /^[0-9]+(?:\.[0-9]+)?$/,
  supply_area_max_m2: /^[0-9]+(?:\.[0-9]+)?$/,
  move_in_start_month: profileMonth,
  move_in_end_month: profileMonth,
};
function profileValues(fields, allowRemoval = false) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  return Object.entries(fields).every(([key, value]) => {
    if (!Object.hasOwn(profilePatterns, key) && key !== 'region_codes') return false;
    if (value === null) return allowRemoval;
    if (key === 'region_codes') return Array.isArray(value) && value.every(code => typeof code === 'string' && /^[0-9]{5}$/.test(code));
    return typeof value === 'string' && profilePatterns[key].test(value);
  });
}
const profileStatuses = new Set(['pending', 'approved', 'rejected', 'cancelled']);
const validRevision = n => Number.isSafeInteger(n) && n >= 0;
const validTimestamp = s => typeof s === 'string' && Number.isFinite(Date.parse(s));
function validProfileProposal(p) {
  return p && uuid.test(p.id) && validRevision(p.baseRevision) && profileStatuses.has(p.status)
    && typeof p.reason === 'string' && validTimestamp(p.createdAt)
    && (p.status === 'pending' ? p.decidedAt === null : validTimestamp(p.decidedAt))
    && ((p.analysisId === null && p.runId === null) || (uuid.test(p.analysisId) && uuid.test(p.runId)))
    && profileValues(p.previous, true) && profileValues(p.patch, true)
    && Object.keys(p.patch).length > 0 && Object.keys(p.previous).length === Object.keys(p.patch).length
    && Object.keys(p.patch).every(key => Object.hasOwn(p.previous, key));
}
async function profileRpc(name, params, signal) {
  const session = await currentSession();
  if (!identity(session)) throw apiError('authentication_required');
  const sdk = await client();
  signal?.throwIfAborted();
  // 계정 전환 직전의 요청도 해당 동작을 시작한 세션으로만 보낸다.
  let query = sdk.rpc(name, params).setHeader('Authorization', 'Bearer ' + session.access_token);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  signal?.throwIfAborted();
  if (error) {
    if (['40001', 'PT409', '23505'].includes(error.code)) throw apiError('profile_changed');
    if (error.code === '22023') throw apiError('invalid_profile_input');
    if (error.code === 'PT404') throw apiError('profile_proposal_not_found');
    if (error.code === 'PT403') throw apiError('profile_regions_unavailable');
    throw databaseError(error);
  }
  if (data?.contractVersion !== 'shared-profile/v1' || !validRevision(data.revision) ||
      (data.updatedAt !== null && !validTimestamp(data.updatedAt)) ||
      (data.destination !== null && typeof data.destination !== 'string') ||
      !profileValues(data.conditions) || !Array.isArray(data.proposals) || data.proposals.length > 30 ||
      !data.proposals.every(validProfileProposal) || (data.nextCursor !== null && !uuid.test(data.nextCursor))) {
    throw apiError('backend_unavailable');
  }
  return data;
}
export function readSharedProfile(signal, before = null) {
  return profileRpc('read_search_profile', { p_before: before }, signal);
}
export function proposeSearchProfile({ requestId, baseRevision, patch, reason, analysisId, runId }, signal) {
  return profileRpc('propose_search_profile_change', {
    p_request_id: requestId, p_base_revision: baseRevision, p_patch: patch, p_reason: reason,
    p_analysis_id: analysisId ?? null, p_run_id: runId ?? null,
  }, signal);
}
export function decideSearchProfile(changeId, decision, signal) {
  return profileRpc('decide_search_profile_change', { p_change_id: changeId, p_decision: decision }, signal);
}

const fundFields = 'id,kind,amountWon:amount_won::text,availableOn:available_on,certainty,updatedAt:updated_at';

async function fundTable(analysisId, ownerId) {
  const owner = await getSession();
  if (!owner || owner.id !== ownerId) throw apiError('authentication_required');
  if (!uuid.test(analysisId)) throw apiError('invalid_funding_input');
  return (await client()).from('funding_entries');
}

export async function listFunds(analysisId, ownerId) {
  const table = await fundTable(analysisId, ownerId);
  const all = [];
  const pageSize = 200;
  // 고정 순서와 식별자 커서로 Data API의 기본 반환 건수 너머에 있는 입력도 복원한다.
  let after;
  do {
    let query = table.select(fundFields).eq('user_id', ownerId).eq('analysis_id', analysisId).order('id').limit(pageSize);
    if (after) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) throw databaseError(error);
    if (!Array.isArray(data) || data.some(row => !uuid.test(row.id) || typeof row.amountWon !== 'string'))
      throw apiError('backend_unavailable');
    all.push(...data);
    after = data.length === pageSize ? data.at(-1).id : null;
  } while (after);
  return all.sort((a, b) => a.availableOn.localeCompare(b.availableOn) || a.id.localeCompare(b.id));
}

export async function saveFund(analysisId, ownerId, draft) {
  const table = await fundTable(analysisId, ownerId);
  const values = { kind: draft.kind, certainty: draft.certainty, amount_won: draft.amountWon, available_on: draft.availableOn };
  const own = query => query.eq('user_id', ownerId).eq('analysis_id', analysisId);
  const matches = row => row && row.kind === draft.kind && row.certainty === draft.certainty
    && row.amountWon === draft.amountWon && row.availableOn === draft.availableOn;
  if (draft.id) {
    const { data, error } = await own(table.update(values)).eq('id', draft.id)
      .eq('updated_at', draft.updatedAt).select('id').maybeSingle();
    if (error) throw databaseError(error);
    if (data) return;
    const current = await own(table.select(fundFields)).eq('id', draft.id).maybeSingle();
    if (current.error) throw databaseError(current.error);
    if (!matches(current.data)) throw apiError('fund_changed');
    return;
  }
  const result = await table.insert({ ...values, user_id: ownerId, analysis_id: analysisId, request_key: draft.requestKey });
  if (!result.error) return;
  if (result.error.code !== '23505') throw databaseError(result.error);
  const prior = await own(table.select(fundFields)).eq('request_key', draft.requestKey).maybeSingle();
  if (prior.error) throw databaseError(prior.error);
  if (!matches(prior.data)) throw apiError('fund_changed');
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
export function getConversation(analysisId, runId, signal) {
  return request(runPath(analysisId, runId) + '/conversation', 'GET', undefined, signal);
}
export function sendConversationMessage(analysisId, runId, requestId, message, signal) {
  if (!uuid.test(requestId) || typeof message !== 'string') throw apiError('invalid_conversation_input');
  const count = Array.from(message).length;
  if (count < 1 || count > 800) throw apiError('invalid_conversation_input');
  return request(runPath(analysisId, runId) + '/conversation', 'POST', { requestId, message }, signal);
}
export function decideConversationProposal(analysisId, runId, turnId, decision, signal) {
  if (
    typeof turnId !== 'string' ||
    !turnId ||
    turnId.includes('/') ||
    !['approve', 'reject', 'cancel'].includes(decision)
  )
    throw apiError('invalid_conversation_input');
  return request(
    runPath(analysisId, runId) + '/conversation/' + encodeURIComponent(turnId) + '/decision',
    'POST',
    { decision },
    signal,
  );
}
