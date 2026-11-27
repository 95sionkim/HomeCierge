import { ApiError, isUuid, readJsonRequest } from './http-input.js';

export type FundingSelection = { analysisId: string; snapshotId: string; modelNo: string; room: string };

// 화면은 분석·수집본과 호실만 선택한다. 자금과 납부 근거는 사용자 세션의 DB에서 읽는다.
export async function readFundingSelection(request: Request, analysisId: string): Promise<FundingSelection> {
  if (!isUuid(analysisId)) throw new ApiError('invalid_funding_input');
  const value = await readJsonRequest(request, 'invalid_funding_input');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !('snapshotId' in value) || !('modelNo' in value) || !('room' in value)) {
    throw new ApiError('invalid_funding_input');
  }
  const { snapshotId, modelNo, room } = value;
  if (!isUuid(snapshotId) || typeof modelNo !== 'string' || !/^[0-9]{1,20}$/.test(modelNo)
    || typeof room !== 'string' || !room || room !== room.trim() || room.length > 120 || /[\p{Cc}\p{Cs}]/u.test(room)) {
    throw new ApiError('invalid_funding_input');
  }
  return { analysisId: analysisId.toLowerCase(), snapshotId: snapshotId.toLowerCase(), modelNo, room };
}
