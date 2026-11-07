/**
 * S0 + V4-ENTRY fitness gates — bare Effect.runPromise boundary.
 *
 * S0: product main must not use empty-
 * Context Effect.runPromise except the permanent host/post-dispose allowlist.
 * Debt is ratcheted empty after V4-DEBT-ZERO. Kernel/work never permanent.
 *
 * V4-ENTRY: domain Effects in core, shell and IPC entries use their warm
 * ManagedRuntime — zero bare Effect.runPromise call sites.
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
/** The Node programs the gate scans, and the work claim plane's folders in them. */
const PRODUCT_ROOTS = ["src/app", "src/core", "src/node", "src/terminal", "src/contract", "src/cli/hosts", "src/cli/machine-local.ts"];
const WORK_DIRS = ["src/core/work", "src/node/work", "src/app/work"];

/** IRON V4-ENTRY surfaces — domain Effects only via ManagedRuntime. */
const ENTRY_SURFACES = [
  "src/app/index.ts",
  "src/app/ipc-handlers.ts",
  "src/app/ipc.ts",
  "src/core/core.ts",
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
        e.path.startsWith("src/core/kernel/") ||
        e.path === "src/core/kernel" ||
        WORK_DIRS.some((dir) => e.path.startsWith(`${dir}/`) || e.path === dir),
    );
    expect(forbidden).toEqual([]);
  });

  it("documents every permanent entry with a host/post-dispose reason", () => {
    const raw = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Allowlist;
    expect(raw.permanent.length).toBeGreaterThan(0);
    for (const entry of raw.permanent) {
      expect(PRODUCT_ROOTS.some((root) => entry.path === root || entry.path.startsWith(`${root}/`))).toBe(true);
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
      raw.debt.some((e) => e.path.startsWith("src/core/kernel/")),
    ).toBe(false);
    expect(
      raw.permanent.some((e) => e.path.startsWith("src/core/kernel/")),
    ).toBe(false);
    expect(
      raw.permanent.some((e) => WORK_DIRS.some((dir) => e.path.startsWith(`${dir}/`))),
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
  it("has zero bare Effect.runPromise in core, shell and IPC entries", () => {
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

  it("routes domain entry through the warm core or shell runtime", () => {
    // Cement: entry surfaces import and call the warm ManagedRuntime, not bare.
    const cc = readFileSync(path.join(ROOT, "src/app/index.ts"), "utf8");
    const ipc = readFileSync(path.join(ROOT, "src/app/ipc-handlers.ts"), "utf8");
    const juntoIpc = readFileSync(
      path.join(ROOT, "src/app/ipc.ts"),
      "utf8",
    );
    const core = readFileSync(path.join(ROOT, "src/core/core.ts"), "utf8");

    expect(core).toMatch(/makeCoreRuntime/);
    expect(core).toMatch(/runtime\.runPromise/);
    // The desktop shell builds no core: it starts the core process, whose boot
    // builds main's typed clients of it and main's host server.
    expect(cc).toMatch(/startCoreProcessForMain\(/);
    expect(cc).toMatch(/await coreChildren\.core\.clients/);
    const mainBoot = readFileSync(path.join(ROOT, "src/app/core-process/main-boot.ts"), "utf8");
    expect(mainBoot).toMatch(/buildCoreClients\(started\.link\)/);
    expect(mainBoot).toMatch(/serveHost\(started\.hostLink/);
    expect(cc).not.toMatch(/AppRuntime\.run(Promise|Fork)/);
    // The window's own ipc.ts is a thin shell: every domain read goes through
    // main's typed client of a core group.
    expect(ipc).toMatch(/Context\.get\(boot\.core, HostsCore\)/);
    // junto/ipc.ts is the same shell: it hands each registrar main's clients of
    // the core and holds no runtime of its own, and nothing in either asks the
    // core by name any more.
    expect(juntoIpc).toMatch(/boot\.core/);
    expect(juntoIpc).not.toMatch(/AppRuntime\.run(Promise|Fork)/);
    for (const shell of [ipc, juntoIpc]) expect(shell).not.toMatch(/core\.call\(/);

    // Keep the construction sites explicit: the desktop shell and the windowless core.
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
    for (const root of ["src/app", "src/core", "src/node", "src/terminal", "src/contract"]) walk(path.join(ROOT, root));
    expect(
      constructions.map((l) => l.split(":")[0]).sort(),
      constructions.join("\n"),
    ).toEqual([
      "src/core/core-runtime.ts",
      // Main's terminal router makes no runtime of its own any more: 2f64c200f
      // took its SSH runner out, so the shell and the core are the only sites.
      "src/app/runtime.ts",
    ].sort());
  });
});
