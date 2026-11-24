// 삭제할 대상은 로그인 정보에서 정한다. 공개 영수증은 작업 상태와 시각만 돌려준다.
import { ApiError, isUuid, readJsonRequest } from './http-input.js';
import { isTimestamp } from './public-fields.js';

const itemKinds = ['chat', 'analysis', 'message', 'turn', 'fund', 'upload', 'report'] as const;
type Item = (typeof itemKinds)[number];
type Scope = Item | 'profile' | 'account';
export type DeletionOperation =
  | { action: 'items'; kind: Item; before: string | null }
  | { action: 'impact'; scope: Scope; targetId: string | null }
  | { action: 'request'; scope: Scope; targetId: string | null; receiptId: string }
  | { action: 'receipt'; receiptId: string };

const counts = ['chats','messages','analyses','runs','turns','funds','reports','uploads','profileChanges'] as const;
const isItem = (v: unknown): v is Item => itemKinds.some(kind => kind === v);
const isScope = (v: unknown): v is Scope => isItem(v) || v === 'account' || v === 'profile';
const isReceiptId = (v: unknown): v is string => isUuid(v) && v[14] === '4' && /^[89ab]$/i.test(v[19]!);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = () => new ApiError('invalid_deletion_input');
const invalidResponse = () => new Error('invalid_deletion_response');
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

async function operation(request: Request, route: string): Promise<DeletionOperation> {
  const url = new URL(request.url);
  if (route === 'items') {
    const kind = url.searchParams.get('kind');
    const before = url.searchParams.get('before');
    if (!isItem(kind) || (before !== null && !isUuid(before)) ||
        [...url.searchParams.keys()].some(k => !['kind','before'].includes(k) || url.searchParams.getAll(k).length > 1)) throw invalid();
    return { action:'items', kind, before:before?.toLowerCase() ?? null };
  }
  if (url.search) throw invalid();
  const body = await readJsonRequest(request, 'invalid_deletion_input');
  if (!record(body)) throw invalid();
  if (route === 'receipt') {
    if (Object.keys(body).length !== 1 || !isReceiptId(body.receiptId)) throw invalid();
    return { action:'receipt', receiptId:body.receiptId.toLowerCase() };
  }
  if (!isScope(body.scope) || (isItem(body.scope) ? !isUuid(body.targetId) : body.targetId !== null)) throw invalid();
  const targetId = isUuid(body.targetId) ? body.targetId.toLowerCase() : null;
  if (route === 'impact' && Object.keys(body).length === 2) return { action:'impact', scope:body.scope, targetId };
  if (route === 'requests' && Object.keys(body).length === 4 && body.confirmed === true && isReceiptId(body.receiptId))
    return { action:'request', scope:body.scope, targetId, receiptId:body.receiptId.toLowerCase() };
  throw invalid();
}

function project(value: unknown, op: DeletionOperation) {
  if (!record(value)) throw invalidResponse();
  if (op.action === 'items') {
    if (!Array.isArray(value.items) || value.items.length > 100 || !(value.nextCursor === null || isUuid(value.nextCursor))) throw invalidResponse();
    const seen = new Set<string>();
    const items = value.items.map((row: unknown) => {
      if (!record(row) || !isUuid(row.id) || seen.has(row.id) || typeof row.label !== 'string' || !row.label || row.label.length > 1000 ||
        !(row.detail == null || (typeof row.detail === 'string' && row.detail.length <= 2000))) throw invalidResponse();
      seen.add(row.id);
      return { id:row.id, label:row.label, detail:row.detail ?? null };
    });
    if (value.nextCursor !== null && value.nextCursor !== items.at(-1)?.id) throw invalidResponse();
    return { items, nextCursor:value.nextCursor };
  }
  // 요금제 자체는 외부 사본과 운영 로그를 포함한 최종 파기일을 입증하지 않는다.
  const backup = { status:'unverified' };
  if (op.action === 'impact') {
    if (value.scope !== op.scope || value.targetId !== op.targetId || !record(value.counts)) throw invalidResponse();
    const data = value.counts;
    const effect = Object.fromEntries(counts.map(k => {
      const n = data[k];
      if (!isCount(n)) throw invalidResponse();
      return [k, n];
    }));
    const { profileCleared, reportsDeleted, reportsUpdated, storageObjects } = value;
    if (typeof profileCleared !== 'boolean' || !isCount(reportsDeleted) || !isCount(reportsUpdated) ||
        !isCount(storageObjects) || reportsDeleted + reportsUpdated !== effect.reports) throw invalidResponse();
    return { scope:op.scope, targetId:op.targetId, counts:effect, profileCleared, reportsDeleted, reportsUpdated, storageObjects, backup };
  }
  if (value.receiptId !== op.receiptId || !isScope(value.scope) || (op.action === 'request' && value.scope !== op.scope) ||
      !isTimestamp(value.requestedAt) ||
      !(value.status === 'processing' && value.completedAt === null ||
        value.status === 'live_deleted' && isTimestamp(value.completedAt) && Date.parse(value.completedAt) >= Date.parse(value.requestedAt)))
    throw invalidResponse();
  let reviewed: { status:string; verifiedAt?:string } = backup;
  if (value.backup !== undefined) {
    if (!record(value.backup)) throw invalidResponse();
    if (value.backup.status === 'verified' && value.status === 'live_deleted' && isTimestamp(value.completedAt) &&
        isTimestamp(value.backup.verifiedAt) && Date.parse(value.backup.verifiedAt) >= Date.parse(value.completedAt))
      reviewed = { status:'verified', verifiedAt:value.backup.verifiedAt };
    else if (value.backup.status !== 'unverified') throw invalidResponse();
  }
  return { receiptId:op.receiptId, scope:value.scope, status:value.status, requestedAt:value.requestedAt, completedAt:value.completedAt, backup:reviewed };
}

export async function serveDeletion(request: Request, headers: Headers, route: string,
  execute: (op: DeletionOperation, signal: AbortSignal) => Promise<unknown>) {
  const op = await operation(request, route);
  const payload = project(await execute(op, request.signal), op);
  const pending = op.action === 'request' && 'status' in payload && payload.status === 'processing';
  return Response.json(payload, { status:pending ? 202 : 200, headers });
}
