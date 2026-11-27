// 외부 응답은 제한된 바이트만 메모리에서 읽고 연결 종료 신호를 따른다.
export async function readLimitedJson(response: Response, signal: AbortSignal, maxResponseBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_provider_response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const bytes = new Uint8Array(maxResponseBytes);
  let length = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (length + value.byteLength > bytes.length) throw new Error('invalid_provider_response');
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
