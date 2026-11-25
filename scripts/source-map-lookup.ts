/**
 * Looks a generated position up in a source map (version 3), without a
 * dependency: the VLQ decoder is small, and a release must be able to map a
 * logged bundle line on any machine that has Bun (scripts/sourcemap-resolve.ts,
 * docs/source-maps.md).
 */

export type RawSourceMap = {
  readonly version: number;
  readonly sources: ReadonlyArray<string>;
  readonly sourcesContent?: ReadonlyArray<string | null>;
  readonly names?: ReadonlyArray<string>;
  readonly mappings: string;
};

/** One mapped segment: where it sits in the generated line, and what it came from. */
export type Segment = {
  /** 1-based generated line. */
  readonly line: number;
  /** 0-based generated column. */
  readonly column: number;
  readonly source: string;
  /** 1-based original line. */
  readonly sourceLine: number;
  /** 0-based original column. */
  readonly sourceColumn: number;
  readonly name: string | undefined;
};

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map<string, number>([...BASE64].map((char, index) => [char, index]));

const decodeVlq = (text: string, start: number): readonly [value: number, next: number] => {
  let result = 0;
  let shift = 0;
  let index = start;
  for (;;) {
    const digit = DIGIT.get(text[index] ?? "");
    if (digit === undefined) throw new Error(`source map mappings: bad character at ${String(index)}`);
    index += 1;
    result += (digit & 31) * 2 ** shift;
    if ((digit & 32) === 0) break;
    shift += 5;
  }
  return [result % 2 === 1 ? -Math.floor(result / 2) : Math.floor(result / 2), index];
};

/** Every segment of the map that has a source, in generated order. */
export const decodeSegments = (map: RawSourceMap): ReadonlyArray<Segment> => {
  const segments: Segment[] = [];
  let line = 1;
  let column = 0;
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let name = 0;
  let index = 0;
  const text = map.mappings;
  while (index <= text.length) {
    const char = text[index];
    if (char === undefined || char === ";" || char === ",") {
      if (char === ";") {
        line += 1;
        column = 0;
      }
      index += 1;
      continue;
    }
    const fields: number[] = [];
    while (index < text.length && text[index] !== "," && text[index] !== ";") {
      const [value, next] = decodeVlq(text, index);
      fields.push(value);
      index = next;
    }
    column += fields[0] ?? 0;
    if (fields.length >= 4) {
      source += fields[1] ?? 0;
      sourceLine += fields[2] ?? 0;
      sourceColumn += fields[3] ?? 0;
      const sourceName = map.sources[source];
      if (sourceName === undefined) throw new Error(`source map mappings: source ${String(source)} is not listed`);
      let nameText: string | undefined;
      if (fields.length >= 5) {
        name += fields[4] ?? 0;
        nameText = map.names?.[name];
      }
      segments.push({ line, column, source: sourceName, sourceLine: sourceLine + 1, sourceColumn, name: nameText });
    }
  }
  return segments;
};

/** The segment a generated position falls in: the last one at or before the column on that line. */
export const lookup = (segments: ReadonlyArray<Segment>, line: number, column: number): Segment | undefined => {
  let found: Segment | undefined;
  for (const segment of segments) {
    if (segment.line !== line) continue;
    if (segment.column > column) break;
    found = segment;
  }
  return found;
};

/** Every distinct original position that a generated line holds, for a log that names a line and no column. */
export const lineOrigins = (segments: ReadonlyArray<Segment>, line: number): ReadonlyArray<Segment> => {
  const seen = new Set<string>();
  const origins: Segment[] = [];
  for (const segment of segments) {
    if (segment.line !== line) continue;
    const key = `${segment.source}:${String(segment.sourceLine)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    origins.push(segment);
  }
  return origins;
};
