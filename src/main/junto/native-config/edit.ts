/**
 * Read and change one key in a harness config file's text, keeping
 * everything else in it: comments, order, spacing and the other keys.
 *
 * JSON (and JSON with comments) goes through jsonc-parser's edits. TOML is
 * edited by line, and only for top-level keys, the only TOML keys the native
 * catalogue declares; a key inside a table is reported unsupported rather
 * than rewritten.
 */
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export type ScalarValue = boolean | string | number;

export type EditOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

export type ReadOutcome =
  | { readonly ok: true; readonly value: ScalarValue | undefined }
  | { readonly ok: false; readonly message: string };

const isScalar = (value: unknown): value is ScalarValue =>
  typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

// --- JSON ---------------------------------------------------------------

const parseJson = (text: string): { readonly value: unknown; readonly errors: ParseError[] } => {
  const errors: ParseError[] = [];
  const value = text.trim() === "" ? {} : parse(text, errors, { allowTrailingComma: true });
  return { value, errors };
};

export const readJsonKey = (text: string, keyPath: string): ReadOutcome => {
  const { value, errors } = parseJson(text);
  if (errors.length > 0) return { ok: false, message: "The file is not valid JSON" };
  let node: unknown = value;
  for (const part of keyPath.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return { ok: true, value: undefined };
    node = (node as Record<string, unknown>)[part];
  }
  if (node === undefined) return { ok: true, value: undefined };
  return isScalar(node) ? { ok: true, value: node } : { ok: false, message: `${keyPath} holds a value that is not a setting` };
};

const detectIndent = (text: string): { readonly tabSize: number; readonly insertSpaces: boolean } => {
  const line = text.split("\n").find((row) => /^[ \t]+\S/.test(row));
  if (line === undefined) return { tabSize: 2, insertSpaces: true };
  if (line.startsWith("\t")) return { tabSize: 1, insertSpaces: false };
  return { tabSize: line.length - line.trimStart().length, insertSpaces: true };
};

export const writeJsonKey = (text: string, keyPath: string, value: ScalarValue): EditOutcome => {
  const { value: root, errors } = parseJson(text);
  if (errors.length > 0) return { ok: false, message: "The file is not valid JSON" };
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return { ok: false, message: "The file does not hold a JSON object" };
  }
  const base = text.trim() === "" ? "{}\n" : text;
  const edits = modify(base, keyPath.split("."), value, {
    formattingOptions: { ...detectIndent(base), eol: base.includes("\r\n") ? "\r\n" : "\n" },
  });
  return { ok: true, text: applyEdits(base, edits) };
};

// --- TOML (top-level keys) ----------------------------------------------

const isTableHeader = (line: string): boolean => /^\s*\[/.test(line);

const keyPattern = (key: string): RegExp => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*=\\s*)(.*)$`);
};

// Splits `"value" # note` into the value token and what follows it.
const splitValue = (rest: string): { readonly token: string; readonly tail: string } | undefined => {
  if (rest.startsWith('"')) {
    if (rest.startsWith('"""')) return undefined;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "\\") { i++; continue; }
      if (rest[i] === '"') return { token: rest.slice(0, i + 1), tail: rest.slice(i + 1) };
    }
    return undefined;
  }
  if (rest.startsWith("'")) {
    if (rest.startsWith("'''")) return undefined;
    const end = rest.indexOf("'", 1);
    return end < 0 ? undefined : { token: rest.slice(0, end + 1), tail: rest.slice(end + 1) };
  }
  const hash = rest.indexOf("#");
  const token = (hash < 0 ? rest : rest.slice(0, hash)).trimEnd();
  return { token, tail: rest.slice(token.length) };
};

const decodeToken = (token: string): ScalarValue | undefined => {
  if (token.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(token);
      return typeof decoded === "string" ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  if (token.startsWith("'")) return token.slice(1, -1);
  if (token === "true") return true;
  if (token === "false") return false;
  const number = Number(token.replace(/_/g, ""));
  return token !== "" && Number.isFinite(number) ? number : undefined;
};

const encodeValue = (value: ScalarValue): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const topLevelEnd = (lines: readonly string[]): number => {
  const header = lines.findIndex(isTableHeader);
  return header < 0 ? lines.length : header;
};

const checkTomlKey = (key: string): string | undefined =>
  key.includes(".") ? `${key} is inside a TOML table, which Junto does not edit in place` : undefined;

export const readTomlKey = (text: string, key: string): ReadOutcome => {
  const unsupported = checkTomlKey(key);
  if (unsupported !== undefined) return { ok: false, message: unsupported };
  const lines = text.split(/\r?\n/);
  const pattern = keyPattern(key);
  for (const line of lines.slice(0, topLevelEnd(lines))) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const split = splitValue(match[2] ?? "");
    const value = split === undefined ? undefined : decodeToken(split.token);
    return value === undefined ? { ok: false, message: `${key} holds a value Junto does not read` } : { ok: true, value };
  }
  return { ok: true, value: undefined };
};

export const writeTomlKey = (text: string, key: string, value: ScalarValue): EditOutcome => {
  const unsupported = checkTomlKey(key);
  if (unsupported !== undefined) return { ok: false, message: unsupported };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const end = topLevelEnd(lines);
  const pattern = keyPattern(key);
  for (let i = 0; i < end; i++) {
    const match = pattern.exec(lines[i]!);
    if (match === null) continue;
    const split = splitValue(match[2] ?? "");
    if (split === undefined) return { ok: false, message: `${key} holds a multi-line value Junto does not edit` };
    lines[i] = `${match[1]}${encodeValue(value)}${split.tail}`;
    return { ok: true, text: lines.join(eol) };
  }
  // Absent: add it at the end of the top-level keys, before the first table.
  let at = end;
  while (at > 0 && lines[at - 1]!.trim() === "") at--;
  lines.splice(at, 0, `${key} = ${encodeValue(value)}`);
  const joined = lines.join(eol);
  return { ok: true, text: joined.endsWith(eol) || joined === "" ? joined : `${joined}${eol}` };
};

export const readConfigKey = (file: string, text: string, key: string): ReadOutcome =>
  file.endsWith(".toml") ? readTomlKey(text, key) : readJsonKey(text, key);

export const writeConfigKey = (file: string, text: string, key: string, value: ScalarValue): EditOutcome =>
  file.endsWith(".toml") ? writeTomlKey(text, key, value) : writeJsonKey(text, key, value);
