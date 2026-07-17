/**
 * Shared NDJSON chunk splitter for herdr stdout streams (control + observe).
 * Appends `chunk` to `buffer`, invokes `onLine` for every complete non-empty
 * trimmed line, and returns the unconsumed remainder to carry forward.
 */
export const feedNdjson = (
  buffer: string,
  chunk: string,
  onLine: (line: string) => void,
): string => {
  let buf = buffer + chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) onLine(line);
  }
  return buf;
};
