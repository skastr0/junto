/**
 * Shared NDJSON chunk splitter for herdr stdout streams (control + observe).
 * Appends `chunk` to `buffer`, invokes `onLine` for every complete non-empty
 * trimmed line, and returns the unconsumed remainder to carry forward.
 *
 * Bounds the unterminated remainder so a child that never emits a newline
 * (protocol violation, wedged pane, runaway output) cannot grow the buffer
 * without limit. herdr's own wire caps a frame at 2 MiB; base64 encoding
 * inflates that ~1.37x, plus JSON envelope overhead — 8 MiB default leaves
 * generous headroom over the largest legitimate single line.
 */
export const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface FeedNdjsonOptions {
  readonly maxBufferBytes?: number;
  /**
   * Fired when the accumulated unterminated remainder exceeds
   * maxBufferBytes. The buffer is reset to empty before this fires — the
   * caller is responsible for treating the producing child as defective
   * (kill it; the normal close/error handling takes it from there).
   */
  readonly onOverflow?: (bufferedBytes: number) => void;
}

export const feedNdjson = (
  buffer: string,
  chunk: string,
  onLine: (line: string) => void,
  options?: FeedNdjsonOptions,
): string => {
  let buf = buffer + chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) onLine(line);
  }
  const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const bufferedBytes = Buffer.byteLength(buf, "utf8");
  if (bufferedBytes > maxBufferBytes) {
    options?.onOverflow?.(bufferedBytes);
    return "";
  }
  return buf;
};
