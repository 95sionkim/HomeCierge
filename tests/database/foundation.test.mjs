// PGlite 안의 합성 Auth 스키마로 SQL 제약/RLS를 검사한다. 네트워크·실계정 없음.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';

const db = new PGlite();
const a='11111111-1111-4111-8111-111111111111';
const b='22222222-2222-4222-8222-222222222222';
let chatA, chatB, analysisA, analysisB;
async function root() { await db.exec('reset role'); }
async function asUser(id, anonymous=false) {
  await root();
  await db.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claims',$2,false)", [id,JSON.stringify({sub:id,is_anonymous:anonymous})]);
  await db.exec('set role authenticated');
}
async function one(sql,params=[]) { return (await db.query(sql,params)).rows[0]; }
async function proposal(changes,revision=0,user=a) {
  return (await one('insert into public.profile_change_requests(user_id,base_revision,proposed_changes) values ($1,$2,$3) returning id',[user,revision,JSON.stringify(changes)])).id;
}
before(async()=>{
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
  `);
  for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'));
  }
  await db.query('insert into auth.users(id) values ($1),($2)',[a,b]);
  for(const id of [a,b]) {
    await asUser(id);
    await db.query('insert into public.user_profiles(user_id) values ($1)',[id]);
    const chat=await one('insert into public.chats(user_id,title) values ($1,$2) returning id',[id,'합성 테스트']);
    const analysis=await one('insert into public.analyses(user_id,chat_id) values ($1,$2) returning id',[id,chat.id]);
    if(id===a){chatA=chat.id;analysisA=analysis.id;}else{chatB=chat.id;analysisB=analysis.id;}
  }
});
after(async()=>{await db.close();});

test('every product table enables RLS; private ingestion has no client grant',async()=>{
  await root();
  const tables=await db.query("select n.nspname,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private')");
  assert.equal(tables.rows.length,12);
  assert.ok(tables.rows.every(r=>r.relrowsecurity));
  assert.equal((await one("select has_table_privilege('authenticated','private.ingestion_runs','SELECT') as allowed")).allowed,false);
});
test('anonymous role cannot read data; anonymous sign-ins also cannot read owned rows',async()=>{
  await root();await db.exec('set role anon');
  await assert.rejects(db.query('select * from public.chats'),/permission denied/);
  await asUser(a,true);
  assert.equal((await db.query('select * from public.chats')).rows.length,0);
});
test('owner isolation covers reads and cross-owner child references',async()=>{
  await asUser(a);
  assert.equal((await db.query('select * from public.chats')).rows.length,1);
  await assert.rejects(db.query('insert into public.chats(user_id,title) values ($1,$2)',[b,'다른 사용자']),/row-level security/);
  await assert.rejects(db.query("insert into public.chat_messages(user_id,chat_id,role,content) values ($1,$2,'user','합성')",[a,chatB]),/foreign key/);
  await assert.rejects(db.query('update public.chats set user_id=$1 where id=$2',[b,chatA]),/permission denied/);
});
test('clients cannot create assistant messages or mark analysis complete',async()=>{
  await asUser(a);
  await assert.rejects(db.query("insert into public.chat_messages(user_id,chat_id,role,content) values ($1,$2,'assistant','합성')",[a,chatA]),/row-level security/);
  await assert.rejects(db.query("update public.analyses set status='completed' where id=$1",[analysisA]),/permission denied/);
});
test('profile changes remain pending until explicit approval, then apply once',async()=>{
  await asUser(a);
  const id=await proposal({search_conditions:{region_codes:['11215'],budget_max_won:'1200000000'}});
  assert.deepEqual((await one('select search_conditions from public.user_profiles')).search_conditions,{});
  await assert.rejects(db.query("update public.user_profiles set search_conditions='{}'"),/permission denied/);
  await assert.rejects(db.query("update public.profile_change_requests set status='approved' where id=$1",[id]),/permission denied/);
  await db.query("select public.decide_profile_change($1,'approved')",[id]);
  assert.equal((await one('select revision from public.user_profiles')).revision,1);
  assert.equal((await one('select search_conditions from public.user_profiles')).search_conditions.budget_max_won,'1200000000');
  await assert.rejects(db.query("select public.decide_profile_change($1,'approved')",[id]),/already_decided/);
});
test('stale, rejected, cancelled and foreign proposals cannot silently change profile',async()=>{
  await asUser(a);
  const stale=await proposal({commute_destination:'합성 목적지'},0);
  await assert.rejects(db.query("select public.decide_profile_change($1,'approved')",[stale]),/revision_conflict/);
  for(const decision of ['rejected','cancelled']){
    const id=await proposal({commute_destination:'합성 목적지'},1);
    await db.query('select public.decide_profile_change($1,$2)',[id,decision]);
  }
  assert.equal((await one('select commute_destination from public.user_profiles')).commute_destination,null);
  await asUser(b);
  await assert.rejects(db.query("select public.decide_profile_change($1,'approved')",[stale]),/proposal_not_found/);
});
test('profile payload rejects detailed funds and reversed area ranges',async()=>{
  await asUser(a);
  await assert.rejects(proposal({current_funds:100},1),/check constraint/);
  await assert.rejects(proposal({search_conditions:{current_funds:100}},1),/check constraint/);
  await assert.rejects(proposal({search_conditions:{supply_area_min_m2:110,supply_area_max_m2:100}},1),/check constraint/);
});
test('funds are analysis-owned, nonnegative, with only one current balance',async()=>{
  await asUser(a);
  const sql="insert into public.funding_entries(user_id,analysis_id,kind,amount_won,available_on,certainty) values ($1,$2,'current',$3,'2026-11-11','confirmed')";
  await assert.rejects(db.query(sql,[a,analysisB,100]),/foreign key/);
  await assert.rejects(db.query(sql,[a,analysisA,-1]),/check constraint/);
  await db.query(sql,[a,analysisA,100]);
  await assert.rejects(db.query(sql,[a,analysisA,100]),/duplicate key/);
  await asUser(b);
  assert.equal((await db.query('select * from public.funding_entries')).rows.length,0);
});
test('reports are server-written snapshots and cannot cross owner boundaries',async()=>{
  const sql="insert into public.reports(user_id,analysis_id,snapshot_version,result_snapshot,conditions_snapshot,sources_snapshot,unknowns_snapshot,queried_at) values ($1,$2,1,'{}','{}','[]','[]',now())";
  await asUser(a);await assert.rejects(db.query(sql,[a,analysisA]),/permission denied/);
  await root();await assert.rejects(db.query(sql,[a,analysisB]),/foreign key/);
  await db.query(sql,[a,analysisA]);
  await asUser(b);assert.equal((await db.query('select * from public.reports')).rows.length,0);
  await asUser(a);await assert.rejects(db.query("update public.reports set result_snapshot='{}'"),/permission denied/);
});
test('verified supply area needs evidence and cannot use another notice document',async()=>{
  await root();
  await db.exec("insert into public.source_registry(id,display_name) values ('synthetic','합성 자료')");
  const n1=await one("insert into public.notices(source_id,external_id,title,notice_kind,collected_at) values ('synthetic','one','합성','unknown',now()) returning id");
  const n2=await one("insert into public.notices(source_id,external_id,title,notice_kind,collected_at) values ('synthetic','two','합성','unknown',now()) returning id");
  const doc=await one("insert into public.notice_documents(notice_id,official_url,collected_at) values ($1,'https://synthetic.invalid/doc',now()) returning id",[n2.id]);
  await assert.rejects(db.query("insert into public.housing_types(notice_id,external_type_id,label,exclusive_area_m2,supply_area_status) values ($1,'84','84',84,'verified')",[n1.id]),/check constraint/);
  await assert.rejects(db.query("insert into public.housing_types(notice_id,external_type_id,label,supply_area_m2,supply_area_status,source_document_id,source_page) values ($1,'84','84',105,'verified',$2,1)",[n1.id,doc.id]),/foreign key/);
});
test('partial or uncounted collection cannot be stored as complete',async()=>{
  await root();
  await assert.rejects(db.query("insert into private.ingestion_runs(source_id,request_scope,status) values ('synthetic','{}','complete')"),/check constraint/);
  await assert.rejects(db.query("insert into private.ingestion_runs(source_id,request_scope,status,total_count,collected_count,completed_at) values ('synthetic','{}','complete',3,2,now())"),/check constraint/);
});
test('client deletion is held; deleting a synthetic auth account cascades personal rows',async()=>{
  await asUser(a);await assert.rejects(db.query('delete from public.chats'),/permission denied/);
  await root();await db.query('delete from auth.users where id=$1',[a]);
  for(const name of ['user_profiles','chats','chat_messages','profile_change_requests','analyses','funding_entries','reports']) {
    assert.equal((await one(`select count(*)::integer as n from public.${name} where user_id=$1`,[a])).n,0);
  }
  assert.equal((await one('select count(*)::integer as n from public.chats where user_id=$1',[b])).n,1);
});
