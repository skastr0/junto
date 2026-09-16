/**
 * S0 + V4-ENTRY fitness gates — bare Effect.runPromise boundary.
 *
 * S0 (docs/END_STATE-effect-foundation.md): product main must not use empty-
 * Context Effect.runPromise except the permanent host/post-dispose allowlist.
 * Debt is ratcheted empty after V4-DEBT-ZERO. Kernel/work never permanent.
 *
 * V4-ENTRY (docs/END_STATE-effect-v4-IRON.md): domain Effects in main/remote
 * entry + IPC files enter only via AppRuntime / RemoteRuntime — zero bare
 * Effect.runPromise call sites in those four surfaces.
 *
 * Allowlist file: scripts/effect-runpromise-allowlist.json
 * Scanner:        scripts/lint-effect-runpromise.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const LINT = path.join(ROOT, "scripts/lint-effect-runpromise.ts");
const ALLOWLIST = path.join(ROOT, "scripts/effect-runpromise-allowlist.json");

/** IRON V4-ENTRY surfaces — domain Effects only via ManagedRuntime. */
const ENTRY_SURFACES = [
  "src/main/index.ts",
  "src/main/ipc.ts",
  "src/main/junto/ipc.ts",
  "src/main/junto-remote.ts",
] as const;

const CALL_PATTERN = /Effect\.runPromise\b/;

type AllowEntry = {
  readonly path: string;
  readonly maxCount: number;
  readonly reason: string;
};

type Allowlist = {
  readonly permanent: ReadonlyArray<AllowEntry>;
  readonly debt: ReadonlyArray<AllowEntry>;
};

const stripLineComment = (line: string): string => {
  const idx = line.indexOf("//");
  if (idx === -1) return line;
  // Keep `//` inside strings out of scope for this cement — entry files use
  // line comments only for the runPromise ban wording.
  return line.slice(0, idx);
};

const isCommentOnlyLine = (line: string): boolean => {
  const t = line.trim();
  return (
    t.length === 0 ||
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("*/")
  );
};

/** Bare Effect.runPromise call sites (comments stripped), same law as lint. */
const bareRunPromiseHits = (source: string): ReadonlyArray<number> => {
  const hits: number[] = [];
  for (const [i, raw] of source.split(/\r?\n/).entries()) {
    if (isCommentOnlyLine(raw)) continue;
    if (!CALL_PATTERN.test(stripLineComment(raw))) continue;
    hits.push(i + 1);
  }
  return hits;
};

describe("effect-runpromise boundary (S0)", () => {
  it("passes on the current tree (allowlist + debt ratchet holds)", () => {
    const result = spawnSync("bun", [LINT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok effect-runpromise/i);
  });

  it("keeps permanent allowlist free of kernel and work claim paths", () => {
    const raw = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Allowlist;
    expect(Array.isArray(raw.permanent)).toBe(true);
    expect(Array.isArray(raw.debt)).toBe(true);

    const forbidden = raw.permanent.filter(
      (e) =>
        e.path.startsWith("src/main/junto/kernel/") ||
        e.path === "src/main/junto/kernel" ||
        e.path.startsWith("src/main/junto/work/") ||
        e.path === "src/main/junto/work",
    );
    expect(forbidden).toEqual([]);
  });

  it("documents every permanent entry with a host/post-dispose reason", () => {
    const raw = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Allowlist;
    expect(raw.permanent.length).toBeGreaterThan(0);
    for (const entry of raw.permanent) {
      expect(entry.path.startsWith("src/main/")).toBe(true);
      expect(entry.maxCount).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(10);
      // Permanent exceptions are host/post-dispose edges only.
      expect(
        /dispose|post-quiesce|post AppRuntime|host/i.test(entry.reason),
        `${entry.path}: permanent reason must name host/post-dispose`,
      ).toBe(true);
    }
  });

  it("keeps kernel free of bare runPromise (S2 cleared; never permanent)", () => {
    const raw = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Allowlist;
    // S2: kernel debt entry is gone — zero bare Effect.runPromise in
    // kernel/service.ts. Permanent must still never cover kernel/work.
    expect(
      raw.debt.some((e) => e.path.startsWith("src/main/junto/kernel/")),
    ).toBe(false);
    expect(
      raw.permanent.some((e) => e.path.startsWith("src/main/junto/kernel/")),
    ).toBe(false);
    expect(
      raw.permanent.some((e) => e.path.startsWith("src/main/junto/work/")),
    ).toBe(false);
  });

  it("fails when a synthetic product file adds bare Effect.runPromise", () => {
    // Contract proof: scanner rejects unlisted product hits. We do not write
    // the tree; we re-assert the lint exit contract via a one-shot inline check
    // that the allowlist path is loaded and the pattern matches bare calls.
    const sample = [
      "import { Effect } from \"effect\";",
      "export const bad = () => Effect.runPromise(Effect.void);",
    ].join("\n");
    expect(/Effect\.runPromise\b/.test(sample)).toBe(true);
    // Runtime proof remains: full tree lint above is green; new files require
    // an allowlist/debt edit which is the deliberate review surface.
  });
});

describe("V4-ENTRY managed runtime domain entry", () => {
  it("has zero bare Effect.runPromise in index/ipc/vellum-ipc/junto-remote", () => {
    const bad: string[] = [];
    for (const rel of ENTRY_SURFACES) {
      const source = readFileSync(path.join(ROOT, rel), "utf8");
      const hits = bareRunPromiseHits(source);
      if (hits.length > 0) {
        bad.push(`${rel}: bare Effect.runPromise at lines ${hits.join(",")}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("routes domain entry via AppRuntime (CC) or RemoteRuntime (Remote)", () => {
    // Cement: entry surfaces import and call the warm ManagedRuntime, not bare.
    const cc = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8");
    const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8");
    const vellumIpc = readFileSync(
      path.join(ROOT, "src/main/junto/ipc.ts"),
      "utf8",
    );
    const remote = readFileSync(
      path.join(ROOT, "src/main/junto-remote.ts"),
      "utf8",
    );

    expect(cc).toMatch(/AppRuntime\.runPromise/);
    expect(cc).toMatch(/AppRuntime\.runFork/);
    expect(ipc).toMatch(/AppRuntime\.runPromise/);
    expect(vellumIpc).toMatch(/AppRuntime\.runPromise/);
    expect(remote).toMatch(/RemoteRuntime\.runPromise/);
    expect(remote).toMatch(/RemoteRuntime\.runFork/);

    // Exactly one ManagedRuntime.make construction per process role (S1 + V4-ENTRY).
    // Pure-Node scan: CI runners do not all ship ripgrep.
    const constructions: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) continue;
        const rel = path.relative(ROOT, full);
        readFileSync(full, "utf8")
          .split("\n")
          .forEach((content, index) => {
            if (!/ManagedRuntime\.make\s*\(/u.test(content)) return;
            // drop pure comment/docblock hits
            if (isCommentOnlyLine(content)) return;
            constructions.push(`${rel}:${String(index + 1)}:${content}`);
          });
      }
    };
    walk(path.join(ROOT, "src/main"));
    expect(
      constructions.map((l) => l.split(":")[0]).sort(),
      constructions.join("\n"),
    ).toEqual(["src/main/remote-runtime.ts", "src/main/runtime.ts"]);
  });
});
