import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createHandler, type Backend } from '../../src/server/handler.js';
import type { DeletionOperation } from '../../src/server/data-deletion.js';
import { createBackend } from '../../src/server/supabase.js';

const service = 'https://hc.invalid';
const owner = randomUUID();
const target = randomUUID();
const receipt = randomUUID();
const requestedAt = '2026-11-24T06:00:00Z';
const env = { SUPABASE_URL:'https://hc.supabase.co', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic', APP_ENV:'development' };

function fixture(run: Backend['dataDeletion']) {
  const calls: string[] = [];
  const handle = createHandler({ env, createBackend: config => ({
    getUser: async () => { calls.push('auth'); return config.token === 'synthetic' ? { id:owner, isAnonymous:false } : null; },
    dataDeletion: async (op: DeletionOperation, signal: AbortSignal) => { calls.push(op.action); return run(op, signal); },
  } as Backend), log(){} });
  const request = (route: string, body?: unknown, auth = true, method = body === undefined ? 'GET' : 'POST') =>
    handle(new Request(service + '/api/v1/privacy/' + route, { method,
      headers:{ ...(auth ? { Authorization:'Bearer synthetic' } : {}), ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { calls, request };
}

test('삭제 영향과 요청은 소유자 세션을 요구하고 확인 버튼 없이 실행할 수 없다', async () => {
  const { calls, request } = fixture(async () => { throw Error(); });
  assert.equal((await request('impact', { scope:'fund', targetId:target }, false)).status, 401);
  assert.equal((await request('requests', { scope:'account', targetId:null, receiptId:receipt }, false)).status, 401);
  for (const body of [
    { scope:'account', targetId:null, receiptId:receipt, confirmed:false },
    { scope:'account', targetId:owner, receiptId:receipt, confirmed:true },
    { scope:'profile', targetId:null, receiptId:receipt, confirmed:true, ownerId:owner },
    { scope:'fund', targetId:null, receiptId:receipt, confirmed:true },
    { scope:'fund', targetId:target, receiptId:'00000000-0000-0000-0000-000000000001', confirmed:true },
  ]) assert.equal((await request('requests',body)).status, 400);
  assert.equal((await request('items?kind=report&kind=fund')).status, 400);
  assert.equal((await request('requests',undefined,true,'DELETE')).status, 405);
  assert.ok(calls.every(x => x === 'auth'));
});

test('공개 영수증은 접수번호만 본문으로 받으며 계정·경로·내부 필드를 내보내지 않는다', async () => {
  const response = { receiptId:receipt, scope:'account', status:'processing', requestedAt, completedAt:null,
    ownerId:owner, paths:['private.pdf'], email:'synthetic@example.invalid' };
  const { calls, request } = fixture(async () => response);
  const reply = await request('receipt',{receiptId:receipt},false);
  assert.equal(reply.status,200);
  assert.deepEqual(await reply.json(),{ receiptId:receipt, scope:'account', status:'processing', requestedAt, completedAt:null, backup:{status:'unverified'} });
  assert.equal(reply.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(calls,['receipt']);
  assert.equal((await request('receipt?receiptId=' + receipt, undefined, false)).status,405);
  assert.equal((await request('receipt?receiptId=' + receipt, {receiptId:receipt}, false)).status,400);
});

test('접수 응답은 단계와 대상에 묶이고 검증된 완료일만 표시한다', async () => {
  const base = { receiptId:receipt, scope:'analysis', status:'processing', requestedAt, completedAt:null as string|null };
  let reply: Record<string,unknown> = {...base};
  const { request } = fixture(async () => reply);
  const post = () => request('requests', {scope:'analysis', targetId:target, receiptId:receipt, confirmed:true});
  assert.equal((await post()).status,202);
  for (const wrong of [{scope:'chat'},{receiptId:randomUUID()},{status:'live_deleted'},{backup:{status:'verified',verifiedAt:requestedAt}}]) {
    reply = {...base,...wrong}; assert.equal((await post()).status,503);
  }
  reply = {...base,status:'live_deleted',completedAt:requestedAt,backup:{status:'verified',verifiedAt:requestedAt,internal:'private'}};
  const completed = await post();
  assert.equal(completed.status,200);
  assert.deepEqual((await completed.json()).backup,{status:'verified',verifiedAt:requestedAt});
});

test('실제 SDK가 비로그인 조회에 공개 키만 사용하고 요청 본문을 최소화한다', async (t) => {
  const observed: {path:string;auth:string|null;body:unknown}[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input,init);
    observed.push({path:new URL(req.url).pathname, auth:req.headers.get('authorization'), body:await req.json()});
    return Response.json({receiptId:receipt,scope:'profile',status:'live_deleted',requestedAt,completedAt:requestedAt});
  });
  const handle = createHandler({env,createBackend,log(){}});
  const reply = await handle(new Request(service+'/api/v1/privacy/receipt', {method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer synthetic-expired-session'}, body:JSON.stringify({receiptId:receipt})}));
  assert.equal(reply.status,200);
  assert.deepEqual(observed,[{path:'/rest/v1/rpc/read_deletion_receipt',auth:'Bearer '+env.SUPABASE_PUBLISHABLE_KEY,body:{p_receipt:receipt}}]);
});

test('영향을 조회할 때 선택한 항목의 실제 개수와 관련 자료만 노출한다', async () => {
  const counts = {chats:0,messages:0,analyses:0,runs:0,turns:0,funds:1,reports:2,uploads:0,profileChanges:0};
  const effects = {profileCleared:false,reportsDeleted:1,reportsUpdated:1,storageObjects:0};
  const { request } = fixture(async op => {
    assert.deepEqual(op,{action:'impact',scope:'fund',targetId:target});
    return {scope:'fund',targetId:target,counts:{...counts,internal:7},...effects,privateData:'fixture'};
  });
  const reply = await request('impact',{scope:'fund',targetId:target});
  assert.equal(reply.status,200);
  assert.deepEqual(await reply.json(),{scope:'fund',targetId:target,counts,...effects,backup:{status:'unverified'}});
  effects.reportsDeleted = 2;
  assert.equal((await request('impact',{scope:'fund',targetId:target})).status,503);
});
