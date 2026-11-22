// 합성 응답으로 주소 대조, 수단별 실패, 사용자 JWT와 외부 요청의 경계를 검사한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCommute, commuteDestination } from '../../src/server/commute.js';
import { createHandler } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';

const analysisId='b5000000-0000-4000-8000-000000000001', snapshotId='b5000000-0000-4000-8000-000000000002';
const ready={analysisId,snapshotId,status:'ready',originAddress:'서울특별시 가람구 예시로 10',transit:true,driving:true,geocode:true};
const destination='서울특별시 가람구 합성길 20';
const transit = {result:{searchType:0,path:[{pathType:3,info:{totalTime:31,totalWalkTime:-1,totalWalk:230}}]}};
const car = {routes:[{result_code:0,summary:{distance:3100,duration:601}}]};
const options={kakaoKey:'synthetic-kakao',odsayKey:'synthetic-odsay',now:()=>new Date('2026-10-27T08:00:00Z'),signal:new AbortController().signal};
function located(address: string) {
  const x=address === destination ? '127.11':'127.10';
  return {meta:{total_count:1,is_end:true},documents:[{address_type:'ROAD_ADDR',address_name:address.replace('서울특별시','서울'),x,y:'37.4'}]};
}
function upstream(change: { geocode?: (address:string)=>unknown; transit?:unknown; car?: unknown }={}) {
  const calls: Request[]=[];
  const fetcher:typeof fetch=async (input,init) => {
    const req=new Request(input,init), url=new URL(req.url);
    calls.push(req);
    const address=url.searchParams.get('query')!;
    if(url.hostname==='dapi.kakao.com') return Response.json(change.geocode ? change.geocode(address) : located(address));
    const value=url.hostname==='api.odsay.com' ? change.transit ?? transit : change.car ?? car;
    return value instanceof Response ? value : Response.json(value);
  };
  return {fetcher,calls};
}

test('binds two building addresses, sends just coordinates to route providers and preserves units and missing walking time',async()=>{
  const {fetcher,calls}=upstream();
  const result=await readCommute(ready,analysisId,snapshotId,destination,{...options,fetch:fetcher});
  assert.equal(result.status,'ready'); assert.equal(calls.length,4);
  assert.equal(result.transit.durationSeconds,1860); assert.equal(result.transit.walkMinutes,null);
  assert.equal(result.transit.walkMeters,230); assert.equal(result.driving.durationSeconds,601);
  assert.equal(result.driving.distanceMeters,3100); assert.equal(result.transit.queriedAt,options.now().toISOString());
  const ods=calls.find(r=>r.url.startsWith('https://api.odsay.com/'))!, drive=calls.find(r=>r.url.startsWith('https://apis-navi.'))!;
  assert.equal(ods.method,'POST'); assert.equal(ods.headers.get('authorization'),null);
  const fields = new URLSearchParams(await ods.text());
  assert.equal(fields.get('SX'),'127.10'); assert.equal(fields.get('EX'),'127.11'); assert.equal(fields.get('OPT'),'0');
  assert.equal(new URL(drive.url).searchParams.get('summary'),'true'); assert.equal(drive.headers.get('authorization'),'KakaoAK synthetic-kakao');
  assert.ok(calls.every(r=>r.redirect==='error' && r.cache==='no-store'));
  assert.ok(!JSON.stringify(result).includes(destination) && !JSON.stringify(result).includes('synthetic-kakao'));
});
test('a provider error, missing walking time, or intercity connections are independent of the other mode',async()=>{
  for(const [payload,status] of [
    [{error:[{code:'-98'}]},'points_too_close'], [{error:[{code:'-99'}]},'no_route'],
    [{error:[{code:'500',message:'[ApiKeyAuthFailed]'}]},'provider_denied'], [{result:{searchType:1}},'connections_unverified'],
    [{result:{searchType:0,path:[]}},'provider_unavailable'], [new Response(null,{status:429}),'rate_limited'],
  ] as const) {
    const {fetcher}=upstream({transit:payload});
    const r=await readCommute(ready,analysisId,snapshotId,destination,{...options,fetch:fetcher});
    assert.equal(r.transit.status,status); assert.equal(r.transit.durationSeconds,null); assert.equal(r.driving.status,'available');
  }
  for (const [payload,status] of [[{routes:[{result_code:104}]},'points_too_close'],[{routes:[{result_code:1}]},'no_route'],
    [{routes:[]},'provider_unavailable'],[new Response(null,{status:403}),'provider_denied']] as const) {
    const {fetcher}=upstream({car:payload,transit:{result:{searchType:0,path:[{pathType:1,info:{totalTime:15,totalWalkTime:0,totalWalk:0}}]}}});
    const r=await readCommute(ready,analysisId,snapshotId,destination,{...options,fetch:fetcher});
    assert.equal(r.driving.status,status); assert.equal(r.driving.durationSeconds,null);
    assert.equal(r.transit.walkMinutes,0); assert.equal(r.transit.status,'available');
  }
});
test('denied sources, unbound origin, missing keys and interrupted requests stop at their scope',async()=>{
  const {fetcher,calls}=upstream();
  for (const ctx of [{...ready,status:'synthetic_input',originAddress:null,transit:false,driving:false,geocode:false},
    {...ready,geocode:false},{...ready,transit:false,driving:false},{...ready,originAddress:'서울특별시 가람구 일원'}]) {
    await readCommute(ctx,analysisId,snapshotId,destination,{...options,fetch:fetcher});
    assert.equal(calls.length,0);
  }
  await assert.rejects(readCommute({...ready,analysisId:snapshotId},analysisId,snapshotId,destination,{...options,fetch:fetcher}));
  const revoked=await readCommute({...ready,transit:false},analysisId,snapshotId,destination,{...options,fetch:fetcher});
  assert.equal(revoked.transit.status,'source_restricted'); assert.equal(revoked.driving.status,'available');
  assert.equal(calls.length,3);
  const missing=await readCommute(ready,analysisId,snapshotId,destination,{...options,kakaoKey:undefined,fetch:fetcher});
  assert.equal(missing.status,'not_configured'); assert.equal(calls.length,3);
  const aborted=new AbortController();aborted.abort();
  await readCommute(ready,analysisId,snapshotId,destination,{...options,signal:aborted.signal,fetch:fetcher});
  assert.equal(calls.length,3);
});
test('ambiguous, conflicting and area-only geocodes cannot produce a route; the destination is never sent before a verified origin',async()=>{
  for(const invalid of [{meta:{total_count:2,is_end:false},documents:located(destination).documents},
    located(destination),{...located(ready.originAddress),documents:[{...located(ready.originAddress).documents[0],address_type:'REGION'}]},
    {...located(ready.originAddress),documents:[{...located(ready.originAddress).documents[0],x:'37.5',y:'127.2'}]}]) {
    const {fetcher,calls}=upstream({geocode:()=>invalid});
    assert.equal((await readCommute(ready,analysisId,snapshotId,destination,{...options,fetch:fetcher})).status,'origin_unverified');
    assert.equal(calls.length,1);
  }
  const {fetcher,calls}=upstream({geocode:address=>address===destination ? located(ready.originAddress) : located(address)});
  assert.equal((await readCommute(ready,analysisId,snapshotId,destination,{...options,fetch:fetcher})).status,'destination_unverified');
  assert.equal(calls.length,2);
});
test('only the bound authenticated POST accepts a destination and uses the owner RPC before any provider',async t=>{
  const path=`https://app.invalid/api/v1/analyses/${analysisId}/snapshots/${snapshotId}/commute`;
  const headers={Authorization:'Bearer SYNTHETIC_USER','Content-Type':'application/json'};
  let rpc=Response.json(ready), count=0;
  t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init); assert.equal(req.headers.get('authorization'),headers.Authorization);
    if(req.url.endsWith('/auth/v1/user')) return Response.json({id:analysisId,is_anonymous:false});
    assert.ok(req.url.endsWith('/rpc/prepare_analysis_commute'));
    assert.deepEqual(await req.json(),{p_analysis_id:analysisId,p_snapshot_id:snapshotId});
    count++;return rpc.clone();
  });
  const {fetcher,calls}=upstream();
  const handler=createHandler({env:{APP_ENV:'development',SUPABASE_URL:'https://db.invalid',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_SYNTHETIC',
    KAKAO_REST_API_KEY:options.kakaoKey,ODSAY_API_KEY:options.odsayKey},createBackend,commuteFetch:fetcher,log(){}});
  const post=(body:unknown, url=path)=>new Request(url,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await handler(new Request(path,{method:'POST'}))).status,401);
  assert.equal((await handler(new Request(path,{headers}))).status,405);
  for (const body of [{},{destination:' '},{destination,origin:ready.originAddress},{destination:'https://foo.test'}]) {
    assert.equal(commuteDestination(body),null); assert.equal((await handler(post(body))).status,400);
  }
  assert.equal((await handler(post({destination},path+'?address=test'))).status,400);
  assert.equal(count,0);
  rpc=Response.json({code:'PT404'},{status:404}); assert.equal((await handler(post({destination}))).status,404);
  assert.equal(calls.length,0);
  rpc=Response.json(ready); const response=await handler(post({destination}));
  assert.equal(response.headers.get('cache-control'),'private, no-store'); assert.equal((await response.json()).driving.status,'available');
});
