import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  it("has no projection drop-file transport", () => {
    const projectionDirectory = join(root, "src/main/vellum/projection");
    expect(
      existsSync(projectionDirectory)
        ? readdirSync(projectionDirectory, { withFileTypes: true }).map(
            (entry) => entry.name,
          )
        : [],
    ).toEqual([]);

    const remotePlan = readFileSync(
      join(root, "src/main/vellum/ssh/remote-plan.ts"),
      "utf8",
    );
    expect(remotePlan).not.toContain("incoming.frame");
    expect(remotePlan).not.toContain("applied.ack");
    expect(remotePlan).not.toContain("projection-frame-deliver");
  });

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
      // This is the Box CLI's own `ssh` subcommand, not an OpenSSH binary.
      // The generic Box runner still owns the single, argv-only `box` process.
      "src/main/vellum/box/cli.ts",
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
      // Host configure is product policy over the shared SSH kernel.
      "src/main/vellum/hosts/configure-remote.ts",
      // Platform admission probes uname; Darwin renders the installer command.
      "src/main/vellum/hosts/remote-platform.ts",
      "src/main/vellum/hosts/deploy-darwin.ts",
      // Linux renders fixed preflight/install programs; artifact and station
      // facts cross only the bounded stdin frame owned by SshTransport.
      "src/main/vellum/hosts/deploy-linux.ts",
      // Exact settings snapshot/CAS/rollback policy; SshTransport still owns OpenSSH.
      "src/main/vellum/hosts/remote-settings-transaction.ts",
      "src/main/vellum/term/router.ts",
      // Canonical Station API transport and propagation use typed endpoint
      // values from the SSH kernel; they do not construct free-form commands.
      "src/main/vellum/station/remote-client.ts",
      "src/main/vellum/station/propagation.ts",
      "src/main/vellum/station/fleet-propagation.ts",
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

  it("product modules outside ssh/ do not import makeRemoteCommand", () => {
    // Brand must mean safe product operation — free-form mint is sealed to
    // ssh/* plan compilers and read-commands factories only.
    // Only the identifier makeRemoteCommand (import or call). Type-only imports
    // from ssh/domain (e.g. SshEndpoint) are allowed for product modules.
    const makeRemoteImport =
      /import\s*\{[^}]*\bmakeRemoteCommand\b[^}]*\}\s*from\s*["'][^"']+["']/u;
    const bareMakeRemote = /\bmakeRemoteCommand\s*\(/u;
    const allowed = new Set([
      "src/main/vellum/ssh/domain.ts",
      "src/main/vellum/ssh/read-commands.ts",
      "src/main/vellum/ssh/remote-plan.ts",
      "src/main/vellum/ssh/hermes-remote-plan.ts",
    ]);
    const violations = files.flatMap((path) => {
      const name = display(path);
      if (!name.startsWith("src/")) return [];
      if (allowed.has(name)) return [];
      const source = readFileSync(path, "utf8");
      if (makeRemoteImport.test(source) || bareMakeRemote.test(source)) {
        return [name];
      }
      return [];
    });

    expect(violations).toEqual([]);
  });

  it("public ssh barrel does not export makeRemoteCommand or Darwin freeform compiler", () => {
    const barrel = readFileSync(join(root, "src/main/vellum/ssh/index.ts"), "utf8");
    expect(barrel).not.toMatch(/\bmakeRemoteCommand\b/u);
    expect(barrel).not.toMatch(/\bcompileDarwinRemoteDeployScript\b/u);
  });

  it("hosts never freeform-construct bash -lc remote shell", () => {
    // Darwin residual freeform lives only behind compileDarwinRemoteDeployScript
    // in ssh/remote-plan.ts. Product hosts must not mint bash -lc argv themselves.
    const freeformBashLc = [
      /["'`]bash["'`]\s*,\s*\[\s*["'`]-lc["'`]/u,
      /makeRemoteCommand\s*\(\s*["'`]bash["'`]/u,
      /\[\s*["'`]bash["'`]\s*,\s*["'`]-lc["'`]/u,
      /spawn(?:Sync)?\s*\(\s*["'`](?:\/[^"'`]+\/)?bash["'`]\s*,\s*\[\s*["'`]-lc["'`]/u,
    ];
    const hostFiles = files.filter((path) =>
      display(path).startsWith("src/main/vellum/hosts/"),
    );
    const violations = hostFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return freeformBashLc.some((pattern) => pattern.test(source))
        ? [display(path)]
        : [];
    });
    expect(violations).toEqual([]);
  });

  it("compileDarwinRemoteDeployScript is confined to residual Darwin path + compiler", () => {
    const allowed = new Set([
      "src/main/vellum/ssh/remote-plan.ts",
      "src/main/vellum/hosts/deploy-darwin.ts",
    ]);
    const importOrCall = /\bcompileDarwinRemoteDeployScript\b/u;
    const violations = files.flatMap((path) => {
      const name = display(path);
      if (!name.startsWith("src/")) return [];
      if (allowed.has(name)) return [];
      return importOrCall.test(readFileSync(path, "utf8")) ? [name] : [];
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
