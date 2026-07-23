import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [join(root, "src"), join(root, "scripts")];

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".js",
      ".mjs",
      ".cjs",
      ".sh",
    ].includes(extname(path))
      ? [path]
      : [];
  });

const files = sourceRoots.flatMap(sourceFiles);
const display = (path: string): string => relative(root, path);

describe("SSH architecture", () => {
  it("keeps OpenSSH process construction inside the transport kernel", () => {
    const forbidden = [
      /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|runCli)\s*\(\s*["'`](?:\/[^"'`]+\/)?ssh(?:\s|["'`])/u,
      /\bBun\.spawn(?:Sync)?\s*\(\s*(?:\[\s*)?["'`](?:\/[^"'`]+\/)?ssh["'`]/u,
      /\bCommand\.make\s*\(\s*["'`](?:\/[^"'`]+\/)?ssh["'`]/u,
      /\bcommand\s*:\s*["'`](?:\/[^"'`]+\/)?ssh["'`]/u,
      /\b(?:ControlMaster|ControlPath|ControlPersist|ServerAliveInterval|ServerAliveCountMax)=/u,
    ];
    const allowedBinaryMentions = new Set([
      "scripts/packaged-runtime-smoke.ts",
      // Doctor only checks executability of the OpenSSH client path; spawn stays in kernel.
      "src/main/vellum/hosts/doctor.ts",
    ]);
    const violations = files.flatMap((path) => {
      const name = display(path);
      if (name.startsWith("src/main/vellum/ssh/")) return [];
      const source = readFileSync(path, "utf8");
      const shellInvocation =
        extname(path) === ".sh" &&
        /(?:^|[\n;&|()])\s*(?:\/\S+\/)?ssh(?:\s|\\)/u.test(source);
      const binaryIndirection =
        !allowedBinaryMentions.has(name) &&
        /["'`](?:\/[^"'`]+\/)?ssh["'`]/u.test(source);
      return shellInvocation ||
        binaryIndirection ||
        forbidden.some((pattern) => pattern.test(source))
        ? [name]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it("reserves private SSH constructors for product policy renderers", () => {
    const renderers = new Set([
      "src/main/vellum/herdr/transport.ts",
      "src/main/vellum/herdr/plane.ts",
      "src/main/vellum/hermes/transport.ts",
      "src/main/vellum/hosts/doctor.ts",
      // Remote station pull + host configure: product policy over shared SSH kernel.
      "src/main/vellum/canvas-pull.ts",
      "src/main/vellum/hosts/configure-remote.ts",
      // Platform admission probes uname; Darwin renders the installer command.
      "src/main/vellum/hosts/remote-platform.ts",
      "src/main/vellum/hosts/deploy-darwin.ts",
      // Exact settings snapshot/CAS/rollback policy; SshTransport still owns OpenSSH.
      "src/main/vellum/hosts/remote-settings-transaction.ts",
      "src/main/vellum/term/router.ts",
      // Signed station-browser envelopes render one closed SSH stdin operation.
      "src/main/vellum/browser/station-transport.ts",
      // Fleet trust provisioning renders one fixed wrapper with a canonical
      // Ed25519 public record on bounded stdin.
      "src/main/vellum/browser/station-trust.ts",
    ]);
    const privateImport = /(?:from\s+|import\s*\()["'][^"']*\/ssh\/[^"']+["']/u;
    const violations = files.flatMap((path) => {
      const name = display(path);
      // hosts/doctor is a policy renderer (warm + home + closed binary probes).
      if (
        name.startsWith("src/main/vellum/ssh/") ||
        renderers.has(name) ||
        name === "src/main/vellum/hosts/doctor.ts"
      ) {
        return [];
      }
      return privateImport.test(readFileSync(path, "utf8")) ? [name] : [];
    });

    expect(violations).toEqual([]);
  });

  it("reserves shared ControlMaster -O exit for the explicit teardown op, never Layer/Scope disposal", () => {
    // Shared masters are command-scoped (ControlPersist=no), but a headless
    // CLI and the GUI may concurrently share the same ControlPath while the
    // owning command is live; exit-on-dispose would race them.
    // -O exit is reserved for SshTransport.teardown — an explicit operator
    // action the host registry invokes on removal/edit — and must never be
    // reachable from a Scope/Layer finalizer that runs on ordinary dispose.
    const service = readFileSync(
      join(root, "src/main/vellum/ssh/service.ts"),
      "utf8",
    );
    expect(service).toMatch(/ControlPersist=no prevents|Do not issue -O exit/iu);

    const masterExitSites = service.match(/compiler\.masterExit\(/gu) ?? [];
    expect(masterExitSites).toHaveLength(1);

    const teardownStart = service.indexOf("const teardown =");
    const returnStart = service.indexOf("return SshTransport.of(");
    expect(teardownStart).toBeGreaterThan(-1);
    expect(returnStart).toBeGreaterThan(teardownStart);
    // The sole masterExit call site is inside the named teardown operation…
    expect(service.slice(teardownStart, returnStart)).toMatch(
      /compiler\.masterExit\(/u,
    );
    // …and no Scope/Layer finalizer in the file ever reaches it. Scanned by
    // balanced parens, not a [^)]-bounded regex: the latter stops matching
    // at the finalizer body's first nested call (e.g. `Effect.sync(() =>
    // …)`), which is the common shape for real Effect finalizers and would
    // silently defeat a paren-excluding window.
    expect(finalizerBodiesReaching(service, "masterExit(")).toEqual([]);
  });
});

/**
 * Finds every `Effect.addFinalizer(...)` / `Scope.addFinalizer(...)` call in
 * `source` and returns the ones whose (balanced-paren) argument body
 * contains `needle`.
 */
function finalizerBodiesReaching(
  source: string,
  needle: string,
): ReadonlyArray<number> {
  const opener = /(?:Effect|Scope)\.addFinalizer\(/gu;
  const hits: number[] = [];
  for (const match of source.matchAll(opener)) {
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    if (source.slice(bodyStart, i).includes(needle)) hits.push(match.index);
  }
  return hits;
}
