#!/usr/bin/env bun
/**
 * Focus law gate. Focus is operator-owned and `src/renderer/lib/focus-ownership.ts`
 * is its only authority.
 *
 * Rules (renderer sources, tests excluded):
 * 1. No raw `.focus(`, `.blur(`, `.select()`, or JSX `autoFocus` outside the
 *    authority. Use claimFocus / releaseFocus / claimFocusOnMount.
 * 2. Every window- or document-level key listener lives in a file that asks
 *    isOperatorTyping, or carries a `// focus-law: <reason>` note on the
 *    listener line or the line above it (for example an Escape-only close).
 *
 * Run: `bun run lint:focus-law`. Exit 0 = clean; exit 1 = violations printed.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(ROOT, "src/renderer");
const AUTHORITY = "src/renderer/lib/focus-ownership.ts";

const RAW_FOCUS = /\.(?:focus|blur)\(|\.select\(\s*\)|\bautoFocus\b/;
const GLOBAL_KEY_LISTENER =
  /\b(?:window|document|globalThis)\.addEventListener\(\s*["']key(?:down|up|press)["']/;
const KEY_NOTE = /\/\/\s*focus-law:\s*\S/;
const TYPING_GUARD = /\bisOperatorTyping\b/;

type Hit = { readonly file: string; readonly line: number; readonly text: string; readonly rule: string };

const isSource = (name: string): boolean =>
  /\.(?:ts|tsx)$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts");

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && isSource(entry.name)) out.push(full);
  }
  return out;
};

// Strip comments and string/template bodies so prose and selectors never
// count as calls. Line structure is preserved for reporting.
const codeOnly = (text: string): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        // Keep key names visible for rule 2 ("keydown").
        out += text[i] === "\n" ? "\n" : quote === "`" ? " " : text[i];
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const scan = async (abs: string): Promise<Hit[]> => {
  const rel = path.relative(ROOT, abs);
  const raw = await readFile(abs, "utf8");
  const rawLines = raw.split(/\r?\n/);
  const codeLines = codeOnly(raw).split("\n");
  const guarded = TYPING_GUARD.test(raw);
  const hits: Hit[] = [];
  codeLines.forEach((code, index) => {
    const text = (rawLines[index] ?? "").trim().slice(0, 160);
    if (rel !== AUTHORITY && RAW_FOCUS.test(code)) {
      hits.push({ file: rel, line: index + 1, text, rule: "raw focus call outside the authority" });
    }
    if (GLOBAL_KEY_LISTENER.test(code) && !guarded) {
      const noted = KEY_NOTE.test(rawLines[index] ?? "") || KEY_NOTE.test(rawLines[index - 1] ?? "");
      if (!noted) {
        hits.push({ file: rel, line: index + 1, text, rule: "global key listener without isOperatorTyping or a focus-law note" });
      }
    }
  });
  return hits;
};

const files = await walk(RENDERER);
const hits = (await Promise.all(files.map(scan))).flat();

if (hits.length > 0) {
  console.error("lint:focus-law: focus is operator-owned; route it through src/renderer/lib/focus-ownership.ts\n");
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}  ${hit.rule}\n    ${hit.text}`);
  }
  console.error(`\nlint:focus-law: ${hits.length} violation(s)`);
  process.exit(1);
}
console.log(`lint:focus-law: ok (${files.length} renderer files)`);
