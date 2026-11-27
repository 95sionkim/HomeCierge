import { ApiError, isUuid, readBody, readJsonRequest } from './http-input.js';
import { isPublicLabel, isTimestamp } from './public-fields.js';
import { projectSavedReport } from './saved-report.js';

export type ReportOperation =
  | { action: 'save'; analysisId: string; runId: string; requestId: string; fundingRoom?: string }
  | { action: 'read' | 'export' | 'delete'; reportId: string }
  | { action: 'list'; before: string | null };

function uuid(value: unknown) {
  if (!isUuid(value)) throw new ApiError('invalid_report_input');
  return value.toLowerCase();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readList(data: unknown) {
  if (!record(data) || !Array.isArray(data.reports) || (data.nextCursor !== null && !isUuid(data.nextCursor)))
    throw new Error('invalid_report_list');
  const seen = new Set<string>();
  const reports = data.reports.map((r: unknown) => {
    if (
      !record(r) ||
      !isUuid(r.reportId) ||
      seen.has(r.reportId) ||
      !isUuid(r.analysisId) ||
      !isUuid(r.runId) ||
      !isTimestamp(r.createdAt) ||
      typeof r.version !== 'number' ||
      !Number.isSafeInteger(r.version) ||
      r.version <= 0 ||
      (r.dataOrigin !== 'synthetic' && r.dataOrigin !== 'collected')
    )
      throw new Error('invalid_report_list');
    seen.add(r.reportId);
    return {
      reportId: r.reportId,
      analysisId: r.analysisId,
      runId: r.runId,
      version: r.version,
      createdAt: r.createdAt,
      dataOrigin: r.dataOrigin,
      title: isPublicLabel(r.title, 240) ? r.title : null,
      ...(isTimestamp(r.queriedAt) ? { queriedAt: r.queriedAt } : {}),
    };
  });
  if (data.nextCursor !== null && data.nextCursor !== reports.at(-1)?.reportId)
    throw new Error('invalid_report_cursor');
  return { reports, nextCursor: data.nextCursor };
}

export async function serveReport(
  request: Request,
  headers: Headers,
  route: { analysis?: string; run?: string; report?: string; pdf?: boolean },
  run: (operation: ReportOperation, signal: AbortSignal) => Promise<unknown>,
): Promise<Response> {
  const url = new URL(request.url);
  if (!route.report && !route.analysis) {
    const query = url.searchParams;
    if ([...query.keys()].some((k) => k !== 'before') || query.getAll('before').length > 1)
      throw new ApiError('invalid_report_input');
    const before = query.has('before') ? uuid(query.get('before')) : null;
    return Response.json(readList(await run({ action: 'list', before }, request.signal)), { headers });
  }
  if (url.search) throw new ApiError('invalid_report_input');
  if (route.analysis) {
    const analysisId = uuid(route.analysis),
      runId = uuid(route.run);
    const body = await readJsonRequest(request, 'invalid_report_input');
    if (!record(body) || Object.keys(body).some((k) => !['requestId', 'fundingRoom'].includes(k)))
      throw new ApiError('invalid_report_input');
    const fundingRoom = body.fundingRoom;
    if (fundingRoom !== undefined && (typeof fundingRoom !== 'string' || !isPublicLabel(fundingRoom, 120)))
      throw new ApiError('invalid_report_input');
    const raw = await run(
      {
        action: 'save',
        analysisId,
        runId,
        requestId: uuid(body.requestId),
        ...(fundingRoom === undefined ? {} : { fundingRoom }),
      },
      request.signal,
    );
    const report = projectSavedReport(raw);
    if (report.analysisId !== analysisId || report.runId !== runId) throw new Error('invalid_report_binding');
    headers.set('Location', '/api/v1/reports/' + report.reportId);
    return Response.json(report, { status: 201, headers });
  }
  const reportId = uuid(route.report);
  if (request.method === 'DELETE') {
    if ((await readBody(request, 0, 'invalid_report_input')) === null) throw new ApiError('invalid_report_input');
    await run({ action: 'delete', reportId }, request.signal);
    return new Response(null, { status: 204, headers });
  }
  const raw = await run({ action: route.pdf ? 'export' : 'read', reportId }, request.signal);
  const report = projectSavedReport(raw, route.pdf);
  if (report.reportId !== reportId) throw new Error('invalid_report_binding');
  if (!route.pdf) return Response.json(report, { headers });
  const { renderSavedReportPdf } = await import('./report-pdf.js');
  const bytes = await renderSavedReportPdf(report);
  headers.set('Content-Type', 'application/pdf');
  headers.set('Content-Disposition', 'attachment; filename="HomeCierge-report-v' + report.version + '.pdf"');
  return new Response(new Uint8Array(bytes), { headers });
}
