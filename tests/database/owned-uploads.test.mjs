// 합성 자료로 SQL 권한과 Storage 카탈로그의 전이를 확인한다. HTTP와 파일 바이트는 다루지 않는다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createBe03Db } from './helpers/be03-db.mjs';

const bucket = 'analysis-uploads';
const uploadOperation = 'storage.object.upload';
const downloadOperation = 'storage.object.get_authenticated';
const authenticatedReadOperations = [downloadOperation, 'object.get_authenticated_info'];
const deleteOperation = 'storage.object.delete_many';
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const register = 'register_analysis_upload';
const requestDeletion = 'request_analysis_upload_deletion';
const finalizeDeletion = 'finalize_analysis_upload_deletion';
const insertObject = 'insert into storage.objects(bucket_id, name, owner_id, metadata) values ($1, $2, $3, $4)';
const storedPdfMetadata = { mimetype: 'application/pdf', cacheControl: 'max-age=0' };
const readObjects = 'select name from storage.objects where bucket_id = $1 order by name';
const deleteObject = 'delete from storage.objects where bucket_id = $1 and name = $2 returning name';

let db;
let analysisA;
let analysisB;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function useRole(role, userId = null, operation = '', isAnonymous = false) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false),
    set_config('request.jwt.claims', $2, false),
    set_config('storage.operation', $3, false)`, [
    userId ?? '', userId ? JSON.stringify({ sub: userId, is_anonymous: isAnonymous }) : '{}', operation,
  ]);
  await db.exec(`set role ${role}`);
}

async function useUser(userId, operation = '', isAnonymous = false) {
  await useRole('authenticated', userId, operation, isAnonymous);
}

async function newAnalysis(userId) {
  const chat = await one('insert into public.chats(user_id, title) values ($1, $2) returning id',
    [userId, '합성 자료']);
  const analysis = await one('insert into public.analyses(user_id, chat_id) values ($1, $2) returning id',
    [userId, chat.id]);
  return { id: analysis.id, chatId: chat.id };
}

async function uploadRpc(rpc, analysisId, uploadId) {
  return one(`select * from public.${rpc}($1, $2)`, [analysisId, uploadId]);
}

function storeObject(bucketId, path, ownerId, metadata = storedPdfMetadata) {
  return db.query(insertObject, [bucketId, path, ownerId, metadata]);
}

before(async () => {
  db = await createBe03Db();
  await db.query('insert into auth.users(id) values ($1), ($2)', [ownerA, ownerB]);
  analysisA = await newAnalysis(ownerA);
  analysisB = await newAnalysis(ownerB);
});

after(async () => { await db?.close(); });

test('registration derives the private PDF path and scopes duplicate keys by owner and analysis', async () => {
  await db.exec('reset role');
  assert.deepEqual(await one('select id, name, public, allowed_mime_types from storage.buckets where id = $1', [bucket]), {
    id: bucket, name: bucket, public: false, allowed_mime_types: ['application/pdf'],
  });

  const uploadId = randomUUID();
  await useUser(ownerA);
  const first = await uploadRpc(register, analysisA.id, uploadId);
  assert.deepEqual(first, {
    user_id: ownerA, analysis_id: analysisA.id, id: uploadId,
    object_path: `${ownerA}/${analysisA.id}/${uploadId}.pdf`, status: 'registered',
  });
  assert.deepEqual(await uploadRpc(register, analysisA.id, uploadId), first);
  assert.deepEqual((await db.query('select * from public.analysis_uploads where id = $1', [uploadId])).rows, [first]);
  await assert.rejects(uploadRpc(register, analysisB.id, uploadId), { code: 'P0002' });
  await assert.rejects(uploadRpc(register, analysisA.id, null), { code: '22023' });
  await assert.rejects(db.query(`insert into public.analysis_uploads(user_id, analysis_id, id)
    values ($1, $2, $3)`, [ownerA, analysisA.id, randomUUID()]), { code: '42501' });

  await useUser(ownerB);
  assert.equal(await one('select * from public.analysis_uploads where id = $1', [uploadId]), undefined);
  const second = await uploadRpc(register, analysisB.id, uploadId);
  assert.equal(second.object_path, `${ownerB}/${analysisB.id}/${uploadId}.pdf`);
  assert.deepEqual((await db.query('select * from public.analysis_uploads where id = $1', [uploadId])).rows, [second]);
  assert.equal(await one('select * from public.notice_documents'), undefined);
  await useRole('service_role');
  await assert.rejects(db.query('select * from public.analysis_uploads'), { code: '42501' });
});

test('only a registered exact path accepts a standard upload by its authenticated owner', async () => {
  const uploadId = randomUUID();
  const expectedPath = `${ownerA}/${analysisA.id}/${uploadId}.pdf`;
  await useUser(ownerA, uploadOperation);
  await assert.rejects(storeObject(bucket, expectedPath, ownerA), { code: '42501' });
  const upload = await uploadRpc(register, analysisA.id, uploadId);
  for (const wrongPath of [
    upload.object_path.replace('.pdf', '.PDF'),
    upload.object_path.replace(analysisA.id, analysisB.id),
    `extra/${upload.object_path}`,
  ]) {
    await assert.rejects(storeObject(bucket, wrongPath, ownerA), { code: '42501' });
  }
  await assert.rejects(storeObject(bucket, upload.object_path, ownerB), { code: '42501' });
  await assert.rejects(storeObject(bucket, upload.object_path, null), { code: '42501' });

  await useUser(ownerB, uploadOperation);
  await assert.rejects(storeObject(bucket, upload.object_path, ownerB), { code: '42501' });
  await assert.rejects(storeObject(bucket, upload.object_path, ownerA), { code: '42501' });
  await useUser(ownerA, 'storage.object.sign_upload_url');
  await assert.rejects(storeObject(bucket, upload.object_path, ownerA), { code: '42501' });
  await useUser(ownerA, uploadOperation);
  await storeObject(bucket, upload.object_path, ownerA);

  const readObject = 'select name from storage.objects where bucket_id = $1 and name = $2';
  for (const operation of authenticatedReadOperations) {
    await useUser(ownerA, operation);
    assert.deepEqual(await one(readObject, [bucket, upload.object_path]), { name: expectedPath }, operation);
    await useUser(ownerB, operation);
    assert.equal(await one(readObject, [bucket, upload.object_path]), undefined, operation);
  }
  for (const operation of [
    'storage.object.get_public', 'storage.object.info_public', 'storage.object.get_signed', 'storage.object.sign', '',
  ]) {
    await useUser(ownerA, operation);
    assert.equal(await one(readObject, [bucket, upload.object_path]), undefined, operation);
  }
});

test('API-level policies and the storage commit guard prevent overwriting or moving a captured file', async () => {
  await useUser(ownerA, uploadOperation);
  const first = await uploadRpc(register, analysisA.id, randomUUID());
  const target = await uploadRpc(register, analysisA.id, randomUUID());
  await storeObject(bucket, first.object_path, ownerA);
  await assert.rejects(storeObject(bucket, first.object_path, ownerA), { code: '23505' });
  const upsert = `${insertObject} on conflict (bucket_id, name) do update set metadata = '{"overwritten": true}'`;
  await assert.rejects(db.query(upsert, [bucket, first.object_path, ownerA, storedPdfMetadata]), { code: '42501' });

  await useUser(ownerA, 'storage.object.move');
  assert.deepEqual((await db.query('update storage.objects set name = $1 where name = $2 returning name',
    [target.object_path, first.object_path])).rows, []);
  await useRole('service_role');
  await assert.rejects(db.query(upsert, [bucket, first.object_path, ownerA, storedPdfMetadata]), { code: '42501' });
  await assert.rejects(db.query('update storage.objects set name = $1 where name = $2',
    [target.object_path, first.object_path]), { code: '42501' });
  assert.deepEqual(await one('select name, metadata from storage.objects where name = $1', [first.object_path]),
    { name: first.object_path, metadata: storedPdfMetadata });
  assert.equal(await one('select name from storage.objects where name = $1', [target.object_path]), undefined);
});

test('temporary Storage probes can omit cache controls but a stored PDF must have safe directives', async () => {
  await useUser(ownerA, uploadOperation);
  const upload = await uploadRpc(register, analysisA.id, randomUUID());
  const candidate = [bucket, upload.object_path, ownerA];
  const probeMetadata = { mimetype: 'application/pdf', contentLength: 128 };
  const defaultMetadata = { ...storedPdfMetadata, cacheControl: 'max-age=3600' };
  const readStored = 'select metadata from storage.objects where bucket_id = $1 and name = $2';

  // Storage v1.98는 초기 검사와 최종 권한 검사의 INSERT를 저장하지 않는다.
  await db.exec('begin');
  try {
    for (const metadata of [probeMetadata, defaultMetadata]) {
      await db.exec('savepoint storage_permission_probe');
      await storeObject(...candidate, metadata);
      await db.exec('rollback to savepoint storage_permission_probe');
      await db.exec('release savepoint storage_permission_probe');
    }
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }

  const cacheDenied = { code: '42501', message: 'analysis_upload_cache_control_required' };
  await assert.rejects(storeObject(...candidate, probeMetadata), cacheDenied);
  await useRole('service_role');
  for (const metadata of [
    null,
    probeMetadata,
    ...[
      null, '', 'private', defaultMetadata.cacheControl, 'public, max-age=0', 'no-cache, s-maxage=1',
      'max-age=0, max-age=1', 'max-age=0, stale-if-error=600', 'no-cache="Set-Cookie"',
    ].map(cacheControl => ({ ...storedPdfMetadata, cacheControl })),
  ]) {
    await assert.rejects(storeObject(...candidate, metadata), cacheDenied);
  }
  assert.equal(await one(readStored, candidate.slice(0, 2)), undefined);

  await storeObject(...candidate);
  assert.deepEqual(await one(readStored, candidate.slice(0, 2)), { metadata: storedPdfMetadata });
  for (const cacheControl of ['no-cache', 'no-store', 'Private, NO-STORE, max-age=0']) {
    await useUser(ownerA, uploadOperation);
    const retry = await uploadRpc(register, analysisA.id, randomUUID());
    const metadata = { ...storedPdfMetadata, cacheControl };
    await useRole('service_role');
    await storeObject(bucket, retry.object_path, ownerA, metadata);
    assert.deepEqual(await one(readStored, [bucket, retry.object_path]), { metadata });
  }
});

test('other bucket policies cannot widen the private upload bucket', async () => {
  await useUser(ownerA, uploadOperation);
  const upload = await uploadRpc(register, analysisA.id, randomUUID());
  await storeObject(bucket, upload.object_path, ownerA);

  await db.exec('reset role');
  await db.exec('begin');
  try {
    await db.exec(`insert into storage.buckets (id, name) values ('unrelated', 'unrelated');
      create policy synthetic_broad_read on storage.objects for select to anon, authenticated using (true)`);
    await storeObject('unrelated', 'synthetic.txt', ownerA, null);
    for (const [role, userId] of [['authenticated', ownerB], ['anon', null]]) {
      await useRole(role, userId, downloadOperation);
      assert.deepEqual((await db.query(readObjects, [bucket])).rows, []);
      assert.deepEqual((await db.query(readObjects, ['unrelated'])).rows, [{ name: 'synthetic.txt' }]);
    }
  } finally {
    await db.exec('reset role');
    await db.exec('rollback');
  }
});

test('deletion retries are safe around the Storage API step and never re-enable a path', async () => {
  await useUser(ownerA, uploadOperation);
  const upload = await uploadRpc(register, analysisA.id, randomUUID());
  const params = [analysisA.id, upload.id];
  const object = [bucket, upload.object_path];
  await storeObject(...object, ownerA);
  await assert.rejects(uploadRpc(finalizeDeletion, ...params), { code: '55000' });
  await assert.rejects(db.query("update public.analysis_uploads set status = 'deleted' where id = $1", [upload.id]),
    { code: '42501' });
  await assert.rejects(db.query('delete from public.analysis_uploads where id = $1', [upload.id]), { code: '42501' });

  await useUser(ownerA, deleteOperation);
  assert.deepEqual((await db.query(deleteObject, object)).rows, []);
  const pending = await uploadRpc(requestDeletion, ...params);
  assert.equal(pending.status, 'deletion_requested');
  assert.deepEqual(await uploadRpc(requestDeletion, ...params), pending);
  assert.deepEqual(await uploadRpc(register, ...params), pending);
  await assert.rejects(uploadRpc(finalizeDeletion, ...params), { code: '55000' });

  for (const operation of authenticatedReadOperations) {
    await useUser(ownerA, operation);
    assert.equal(await one('select name from storage.objects where bucket_id = $1 and name = $2', object), undefined,
      operation);
  }
  await useUser(ownerA, uploadOperation);
  await assert.rejects(storeObject(...object, ownerA), { code: '42501' });

  await useUser(ownerB, deleteOperation);
  await assert.rejects(uploadRpc(requestDeletion, ...params), { code: 'P0002' });
  await assert.rejects(uploadRpc(finalizeDeletion, ...params), { code: 'P0002' });
  assert.deepEqual((await db.query(deleteObject, object)).rows, []);

  // Storage API .remove()의 DB 역할과 상태 전이만 모형화한다.
  await useUser(ownerA, deleteOperation);
  assert.deepEqual((await db.query(deleteObject, object)).rows, [{ name: upload.object_path }]);
  assert.deepEqual((await db.query(deleteObject, object)).rows, []);
  const deleted = await uploadRpc(finalizeDeletion, ...params);
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual(await uploadRpc(finalizeDeletion, ...params), deleted);
  assert.deepEqual(await uploadRpc(requestDeletion, ...params), deleted);
  assert.deepEqual(await uploadRpc(register, ...params), deleted);
  assert.equal(await one('select * from public.analysis_uploads where id = $1', [upload.id]), undefined);
  await useRole('service_role');
  await assert.rejects(storeObject(...object, ownerA), { code: '42501' });
});

test('anonymous roles and expired account ownership cannot enter the upload lifecycle', async () => {
  await db.exec('reset role');
  const formerOwner = randomUUID();
  await db.query('insert into auth.users(id) values ($1)', [formerOwner]);
  const formerAnalysis = await newAnalysis(formerOwner);
  await db.query('delete from auth.users where id = $1', [formerOwner]);

  await useUser(ownerA, uploadOperation);
  const upload = await uploadRpc(register, analysisA.id, randomUUID());
  const object = [bucket, upload.object_path];
  await storeObject(...object, ownerA);
  await useRole('anon', null, downloadOperation);
  assert.equal(await one('select name from storage.objects where bucket_id = $1 and name = $2', object), undefined);
  await assert.rejects(db.query('select * from public.analysis_uploads'), { code: '42501' });
  for (const rpc of [register, requestDeletion, finalizeDeletion]) {
    await assert.rejects(uploadRpc(rpc, analysisA.id, upload.id), { code: '42501' });
  }
  await useUser(ownerA, downloadOperation, true);
  assert.equal(await one('select * from public.analysis_uploads where id = $1', [upload.id]), undefined);
  assert.equal(await one('select name from storage.objects where bucket_id = $1 and name = $2', object), undefined);
  for (const rpc of [register, requestDeletion, finalizeDeletion]) {
    await assert.rejects(uploadRpc(rpc, analysisA.id, upload.id), { code: '42501' });
  }
  await useUser(ownerA, uploadOperation, true);
  await assert.rejects(storeObject(...object, ownerA), { code: '42501' });

  await useUser(formerOwner, uploadOperation);
  for (const rpc of [register, requestDeletion, finalizeDeletion]) {
    await assert.rejects(uploadRpc(rpc, formerAnalysis.id, upload.id), { code: '42501' });
  }
});

test('cascades wait for cleanup and preserve another account’s objects and registrations', async () => {
  await db.exec('reset role');
  const owner = randomUUID();
  await db.query('insert into auth.users(id) values ($1)', [owner]);
  const analysis = await newAnalysis(owner);
  const uploadId = randomUUID();

  await useUser(owner, uploadOperation);
  const upload = await uploadRpc(register, analysis.id, uploadId);
  const reservation = await uploadRpc(register, analysis.id, randomUUID());
  await storeObject(bucket, upload.object_path, owner);
  await useUser(ownerB, uploadOperation);
  const other = await uploadRpc(register, analysisB.id, uploadId);
  await storeObject(bucket, other.object_path, ownerB);

  await db.exec('reset role');
  const deleteAnalysis = 'delete from public.analyses where id = $1 returning id';
  const deleteAccount = 'delete from auth.users where id = $1 returning id';
  await assert.rejects(db.query(deleteAnalysis, [analysis.id]), { code: '23503' });
  await assert.rejects(db.query('delete from public.chats where id = $1', [analysis.chatId]), { code: '23503' });
  await assert.rejects(db.query(deleteAccount, [owner]), { code: '23503' });
  assert.deepEqual(await one('select name from storage.objects where name = $1', [upload.object_path]),
    { name: upload.object_path });

  await useUser(owner, deleteOperation);
  await uploadRpc(requestDeletion, analysis.id, reservation.id);
  await useRole('service_role');
  // 사전 검사를 통과했어도 아직 저장하지 않은 업로드가 늦게 완료되는 상황을 재현한다.
  await assert.rejects(storeObject(bucket, reservation.object_path, owner), { code: '42501' });
  await useUser(owner, deleteOperation);
  assert.deepEqual((await db.query(deleteObject, [bucket, reservation.object_path])).rows, []);
  assert.equal((await uploadRpc(finalizeDeletion, analysis.id, reservation.id)).status, 'deleted');
  await uploadRpc(requestDeletion, analysis.id, upload.id);
  await db.exec('reset role');
  await assert.rejects(db.query(deleteAccount, [owner]), { code: '23503' });
  await useUser(owner, deleteOperation);
  assert.deepEqual((await db.query(deleteObject, [bucket, upload.object_path])).rows, [{ name: upload.object_path }]);
  await db.exec('reset role');
  await assert.rejects(db.query(deleteAnalysis, [analysis.id]), { code: '23503' });
  await useUser(owner, deleteOperation);
  await uploadRpc(finalizeDeletion, analysis.id, upload.id);

  await db.exec('reset role');
  assert.deepEqual(await one(deleteAccount, [owner]), { id: owner });
  assert.equal(await one('select id from public.analyses where id = $1', [analysis.id]), undefined);
  assert.equal(await one('select id from public.analysis_uploads where user_id = $1', [owner]), undefined);
  assert.equal(await one('select name from storage.objects where name = $1', [upload.object_path]), undefined);
  await useUser(ownerB, downloadOperation);
  assert.ok((await db.query(readObjects, [bucket])).rows.some(row => row.name === other.object_path));
  assert.deepEqual(await one('select * from public.analysis_uploads where id = $1', [uploadId]), other);
});
