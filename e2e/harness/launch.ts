/**
 * Electron launch harness. Wraps the proven playwright-core `_electron`
 * recipe (node runtime only — the Electron driver's launch handshake times
 * out under bun) behind a Playwright fixture so every scenario gets a fully
 * isolated {app, page, sandbox} and guaranteed teardown without hand-rolled
 * try/finally per spec.
 *
 * Isolation invariants (never relaxed):
 *  - throwaway --user-data-dir + HOME per test (sandbox.ts); the app still
 *    resolves its one canonical $HOME/.junto/state/junto.db
 *  - HOME sandboxed to the same temp root + SHELL=/bin/sh, so the adapters'
 *    login-shell PATH probe (src/main/junto/adapters/exec.ts) cannot
 *    resolve the operator's real CLIs
 *  - renderer served from a local static server (127.0.0.1, ephemeral port)
 *    since the trusted renderer protocol only installs when app.isPackaged
 *  - focus isolation: JUNTO_E2E=1 creates off-screen, non-focusable windows
 *    + accessory Dock policy so Playwright never steals macOS focus. Opt into
 *    a visible window for debugging with JUNTO_E2E_SHOW=1 (not --vellum-headless —
 *    that mode has no authoring renderer at all).
 */
import { lstat, readdir, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { test as base, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import type { CanvasDoc } from "../../src/shared/canvas";
import type { HarnessId } from "../../src/shared/managed-terminal-templates";
import type { RemoteHost } from "../../src/shared/remote-hosts";
import type { UsageState } from "../../src/shared/usage";
import {
  seedClaudeModelCache,
  seededHarnessBinDir,
  seedInstalledHarnesses,
  type ClaudeModelCacheEntry,
} from "./agent-harness-fixture";
import {
  createSandbox,
  destroySandbox,
  removeFixtureCanvases,
  writeFixtureCanvas,
  writeFixtureHosts,
  writeFixtureRetiredCommercialState,
  writeFixtureUsageState,
  type Sandbox,
} from "./sandbox";
import { startRendererServer, type RendererServer } from "./renderer-server";

// Scripts always invoke playwright from the repo root (package.json
// "test:e2e:full"/"test:e2e:fast"); resolving from cwd avoids ESM __dirname
// ambiguity under the project's "type": "module".
const REPO_ROOT = process.cwd();
// Electron 43 resolves and, on a fresh install, downloads its platform binary
// through the package entry. Reading its internal path.txt directly bypasses
// that supported bootstrap and makes clean Linux/macOS E2E checkouts fail.
const ELECTRON_BINARY = createRequire(import.meta.url)("electron") as string;
// Launch with the repo root as the app path (Electron resolves the app dir
// from the main-script's package.json walk): the app must see itself at the
// repo root so resources like scripts/unix-peer-pid.py resolve (process-bind
// identity). Launching `out/main/index.js` directly makes Electron resolve
// the app dir as out/main and every work-socket connection is refused.
const MAIN_ENTRY = REPO_ROOT;
const RENDERER_DIR = join(REPO_ROOT, "out/renderer");
// Xvfb has no hardware GL device. Electron's bundled SwiftShader keeps WebGL
// and Three.js real without weakening Chromium's process sandbox.
const PLATFORM_ELECTRON_ARGS =
  process.platform === "linux"
    ? ["--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"]
    : [];

// e2e/fakes/bin/{ssh,hermes} — stock-protocol emulators (see
// e2e/fakes/*.ts for the scenario-file contract each one reads). The system
// floor is the minimal set every adapter still needs (/bin/sh, coreutils);
// nothing above it, so an operator CLI on the real PATH can never leak in.
const FAKES_BIN_DIR = join(REPO_ROOT, "e2e/fakes/bin");
// The fakes are `#!/usr/bin/env node` scripts — env resolves `node` off
// PATH, so the floor must include the node binary actually running this
// harness (proven node runtime, not the operator's PATH) or every fake
// ENOENTs silently under a stripped PATH.
const NODE_BIN_DIR = dirname(process.execPath);
const SYSTEM_PATH_FLOOR = `${NODE_BIN_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`;

export interface LaunchOptions {
  readonly demo?: boolean;
  /** Disable external Node TCP/HTTP and Chromium HTTP before product startup. */
  readonly offline?: boolean;
  /** Canvas name -> document, seeded into the sandbox's SQLite database. */
  readonly seedCanvases?: Readonly<Record<string, CanvasDoc>>;
  /** Enrolled fleet rows seeded into the sandbox's explicit SQLite database. */
  readonly seedHosts?: ReadonlyArray<RemoteHost>;
  /** Preserve stale historical commercial rows while proving ordinary startup. */
  readonly seedRetiredCommercialState?: boolean;
  /**
   * Usage-plane last-good state seeded into the sandbox's `usage_state` row
   * before boot — the same durable seam UsageCache paints at startup.
   */
  readonly seedUsage?: UsageState;
  /**
   * Plant no-op harness CLIs under the sandbox home so the install probe
   * lists them. PATH puts this bin ahead of e2e/fakes/bin.
   */
  readonly seedHarnessInstalls?: readonly HarnessId[];
  /** Write `~/.claude.json` additionalModelOptionsCache before boot. */
  readonly claudeModelCache?: readonly ClaudeModelCacheEntry[];
  /**
   * Direct sandbox surgery after fixture seeding, before the app boots —
   * for durable states that have no producer (e.g. residual `auth-required`
   * work rows only older databases carry).
   */
  readonly afterSeed?: (sandbox: Sandbox) => Promise<void>;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * Extra Chromium switches. The operator runs on a scaled Retina display;
   * the harness window defaults to device-pixel-ratio 1, so anything that only
   * misbehaves at a fractional scale factor is invisible to every spec unless
   * a spec asks for it (`--force-device-scale-factor=1.5`).
   */
  readonly electronArgs?: ReadonlyArray<string>;
}

export interface VellumWorld {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly sandbox: Sandbox;
}

export interface VellumHandle extends VellumWorld {
  readonly close: () => Promise<void>;
}

const APPLICATION_CLOSE_TIMEOUT_MS = 30_000;
const RENDERER_SERVER_CLOSE_TIMEOUT_MS = 5_000;

interface ElectronProcessWitnessSource {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(
    event: "exit",
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

interface ElectronApplicationWitnessSource {
  readonly close: () => Promise<void>;
  readonly process: () => ElectronProcessWitnessSource;
  once(event: "close", listener: () => void): unknown;
}

export interface ElectronApplicationCloseWitness {
  readonly application: ElectronApplicationWitnessSource;
  readonly applicationClosed: Promise<void>;
  readonly processTerminated: Promise<void>;
  readonly didObserveApplicationClose: () => boolean;
  readonly didObserveProcessTermination: () => boolean;
}

export interface HarnessCleanupOperations {
  readonly destroySandbox: (sandbox: Sandbox) => Promise<void>;
  readonly sandboxExists: (root: string) => Promise<boolean>;
}

export type HarnessApplicationState =
  | { readonly kind: "not-launched" }
  /** electron.launch was called but threw before returning an observable handle. */
  | { readonly kind: "launch-unobserved" }
  | {
      readonly kind: "observed";
      readonly witness: ElectronApplicationCloseWitness;
    };

export interface HarnessCleanupInput {
  readonly sandbox: Sandbox;
  readonly server?: RendererServer;
  readonly application: HarnessApplicationState;
}

export interface HarnessCleanupTimeouts {
  readonly applicationCloseMs: number;
  readonly rendererServerCloseMs: number;
}

const socketExists = async (socketPath: string): Promise<boolean> =>
  lstat(socketPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

const findDemoRuntimeDatabase = async (
  searchRoot: string,
): Promise<string | undefined> => {
  let entries;
  try {
    entries = await readdir(searchRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("junto-demo-runtime-"),
      )
      .map(async (entry) => {
        const full = join(searchRoot, entry.name);
        const info = await stat(full).catch(() => undefined);
        return { full, mtimeMs: info?.mtimeMs ?? 0 };
      }),
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    const database = join(candidate.full, "junto.db");
    if (await socketExists(database)) return database;
  }
  return undefined;
};

const defaultCleanupOperations: HarnessCleanupOperations = {
  destroySandbox,
  sandboxExists: (root) => socketExists(root),
};

const defaultCleanupTimeouts: HarnessCleanupTimeouts = {
  applicationCloseMs: APPLICATION_CLOSE_TIMEOUT_MS,
  rendererServerCloseMs: RENDERER_SERVER_CLOSE_TIMEOUT_MS,
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const contextualError = (context: string, error: unknown): Error => {
  const cause = asError(error);
  return new Error(`${context}: ${cause.message}`, { cause });
};

type OperationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Error };

const runBounded = async (
  operation: Promise<unknown>,
  timeoutMs: number,
  label: string,
): Promise<OperationOutcome> => {
  const settled = operation.then<OperationOutcome, OperationOutcome>(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error: contextualError(label, error) }),
  );

  return new Promise<OperationOutcome>((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        ok: false,
        error: new Error(`${label}: timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);
    settled.then((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
};

/**
 * Installs both witnesses immediately after Playwright returns the application
 * handle. No pid is exposed or signalled: the exact ChildProcess object is
 * observed only for its terminal event.
 */
export const observeElectronApplicationClose = (
  application: ElectronApplicationWitnessSource,
): ElectronApplicationCloseWitness => {
  let applicationClosed = false;
  let processTerminated = false;
  const process = application.process();

  const applicationClosedPromise = new Promise<void>((resolve) => {
    application.once("close", () => {
      applicationClosed = true;
      resolve();
    });
  });

  const processTerminatedPromise =
    process.exitCode !== null || process.signalCode !== null
      ? Promise.resolve().then(() => {
          processTerminated = true;
        })
      : new Promise<void>((resolve) => {
          process.once("exit", () => {
            processTerminated = true;
            resolve();
          });
        });

  return {
    application,
    applicationClosed: applicationClosedPromise,
    processTerminated: processTerminatedPromise,
    didObserveApplicationClose: () => applicationClosed,
    didObserveProcessTermination: () => processTerminated,
  };
};

const collectApplicationCleanup = async (
  witness: ElectronApplicationCloseWitness,
  timeoutMs: number,
): Promise<{ readonly safeToDeleteSandbox: boolean; readonly errors: readonly Error[] }> => {
  // Start the close request and both independent witnesses together. A
  // rejected or stuck Playwright close call is reported, but cannot erase an
  // already-proven application/process terminal witness.
  const [closeOutcome, witnessOutcome] = await Promise.all([
    runBounded(
      Promise.resolve().then(() => witness.application.close()),
      timeoutMs,
      "ElectronApplication.close failed",
    ),
    runBounded(
      Promise.all([witness.applicationClosed, witness.processTerminated]),
      timeoutMs,
      "Electron application terminal witness failed",
    ),
  ]);

  const errors: Error[] = [];
  if (!closeOutcome.ok) errors.push(closeOutcome.error);
  if (!witnessOutcome.ok) errors.push(witnessOutcome.error);

  const safeToDeleteSandbox =
    witness.didObserveApplicationClose() && witness.didObserveProcessTermination();
  if (!safeToDeleteSandbox && witnessOutcome.ok) {
    errors.push(
      new Error(
        "Electron application terminal witness completed without both application-close and process-exit observations",
      ),
    );
  }

  return { safeToDeleteSandbox, errors };
};

/**
 * Ordered harness teardown. Every step reports its own failure and later safe
 * cleanup still runs. The sandbox is removed only after the exact Electron
 * application and child process are terminal and the sandbox-local
 * daemon has acknowledged shutdown.
 */
export const cleanupVellumHarness = async (
  input: HarnessCleanupInput,
  operations: HarnessCleanupOperations = defaultCleanupOperations,
  timeouts: HarnessCleanupTimeouts = defaultCleanupTimeouts,
): Promise<void> => {
  const errors: Error[] = [];
  let applicationSafe = input.application.kind === "not-launched";
  let sandboxPreserved = false;

  if (input.application.kind === "observed") {
    const applicationResult = await collectApplicationCleanup(
      input.application.witness,
      timeouts.applicationCloseMs,
    );
    applicationSafe = applicationResult.safeToDeleteSandbox;
    errors.push(...applicationResult.errors);
  } else if (input.application.kind === "launch-unobserved") {
    errors.push(
      new Error(
        "Electron launch returned no application handle; exact process termination cannot be proven",
      ),
    );
  }

  if (input.server !== undefined) {
    const serverOutcome = await runBounded(
      Promise.resolve().then(() => input.server?.close()),
      timeouts.rendererServerCloseMs,
      "renderer server close failed",
    );
    if (!serverOutcome.ok) errors.push(serverOutcome.error);
  }

  if (applicationSafe) {
    try {
      await operations.destroySandbox(input.sandbox);
      if (await operations.sandboxExists(input.sandbox.root)) {
        sandboxPreserved = true;
        errors.push(
          new Error(`sandbox removal did not remove ${input.sandbox.root}`),
        );
      }
    } catch (error) {
      sandboxPreserved = true;
      errors.push(contextualError("sandbox removal failed", error));
    }
  } else {
    sandboxPreserved = true;
    const reasons = [
      ...(applicationSafe ? [] : ["Electron application termination is unproven"]),
    ];
    errors.push(
      new Error(
        `sandbox preserved at ${input.sandbox.root}: ${reasons.join("; ")}`,
      ),
    );
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      sandboxPreserved
        ? `Junto e2e harness cleanup failed; sandbox preserved at ${input.sandbox.root}`
        : "Junto e2e harness cleanup failed",
    );
  }
};

export const launchVellum = async (options: LaunchOptions = {}): Promise<VellumHandle> => {
  const sandbox = await createSandbox();
  let server: RendererServer | undefined;
  let application: HarnessApplicationState = { kind: "not-launched" };

  try {
    if (options.seedRetiredCommercialState === true) {
      await writeFixtureRetiredCommercialState(sandbox);
    }
    for (const [name, doc] of Object.entries(options.seedCanvases ?? {})) {
      await writeFixtureCanvas(sandbox, name, doc);
    }
    if (options.seedHosts !== undefined) {
      await writeFixtureHosts(sandbox, options.seedHosts);
    }
    if (options.seedUsage !== undefined) {
      await writeFixtureUsageState(sandbox, options.seedUsage);
    }
    if (options.seedHarnessInstalls !== undefined) {
      await seedInstalledHarnesses(sandbox, options.seedHarnessInstalls);
    }
    if (options.claudeModelCache !== undefined) {
      await seedClaudeModelCache(sandbox, options.claudeModelCache);
    }
    if (options.afterSeed !== undefined) {
      await options.afterSeed(sandbox);
    }

    server = await startRendererServer(RENDERER_DIR);

    // Drop live seat / work-control env that a factory agent inherits. Spreading
    // process.env would otherwise point the e2e app at the operator's real
    // ~/.junto/work lock (JUNTO_WORK_HOME) and fail work-control startup.
    const inherited = { ...(process.env as Record<string, string>) };
    for (const key of [
      "JUNTO_HOME",
      "JUNTO_WORK_HOME",
      "JUNTO_WORK_SOCKET",
      "JUNTO_SOCKET",
      "JUNTO_NODE_REF",
      "JUNTO_SEAT",
      "JUNTO_TOKEN",
      "JUNTO_WORK_TOKEN",
    ] as const) {
      delete inherited[key];
    }

    const env: Record<string, string> = {
      ...inherited,
      HOME: sandbox.homeDir,
      // Demo isolation mints junto-demo-runtime-* under os.tmpdir().
      // Pin TMPDIR to this launch's sandbox so two workers cannot seed each
      // other's newest demo database. The demo file is SQLite, not a UDS.
      TMPDIR: sandbox.root,
      TMP: sandbox.root,
      TEMP: sandbox.root,
      SHELL: "/bin/sh",
      JUNTO_CANVASES_DIR: sandbox.canvasesDir,
      JUNTO_E2E: "1",
      // Match electron-vite's real development contract exactly. It supplies
      // the loopback authority without a trailing slash; using a normalized
      // test-only URL here previously hid a black-window startup regression.
      ELECTRON_RENDERER_URL: server.url.endsWith("/")
        ? server.url.slice(0, -1)
        : server.url,
      ...(options.demo ? { JUNTO_DEMO: "1" } : {}),
      // Restrict PATH to e2e/fakes/bin + the system floor on every launch — no
      // operator CLI, no real host, no AI tokens. Never opt-in: app boot
      // unconditionally starts the usage-HUD poller (ipc.ts), which probes the
      // native sources the moment any scenario window opens, demo or not. This is
      // one of the isolation invariants at the top of this file, not a
      // per-spec choice. `extraEnv.PATH` (if a spec ever sets it) still wins —
      // it's applied after.
      PATH: `${seededHarnessBinDir(sandbox)}:${FAKES_BIN_DIR}:${SYSTEM_PATH_FLOOR}`,
      ...options.extraEnv,
    };

    application = { kind: "launch-unobserved" };
    const app = await electron.launch({
      executablePath: ELECTRON_BINARY,
      args: [
        ...(options.offline === true
          ? ["-r", join(REPO_ROOT, "e2e/harness/offline-network.cjs")]
          : []),
        MAIN_ENTRY,
        `--user-data-dir=${sandbox.userDataDir}`,
        ...PLATFORM_ELECTRON_ARGS,
        ...(options.electronArgs ?? []),
      ],
      env,
      timeout: 60_000,
    });
    application = {
      kind: "observed",
      witness: observeElectronApplicationClose(app),
    };

    const page = await app.firstWindow();

    // Demo mode runs on a process-minted ephemeral database, so the
    // pre-launch sandbox seed is invisible to the app. Re-seed the same
    // fixtures into the minted file, drop the empty first-run default
    // canvas, then reload the renderer so it boots onto the seeded canvas.
    if (options.demo === true) {
      const seeds = Object.entries(options.seedCanvases ?? {});
      if (seeds.length > 0) {
        const demoDatabase = await findDemoRuntimeDatabase(sandbox.root);
        if (demoDatabase === undefined) {
          throw new Error(
            "demo-mode seed: the app's ephemeral demo database was not found under the sandbox temp root",
          );
        }
        for (const [name, doc] of seeds) {
          await writeFixtureCanvas(sandbox, name, doc, demoDatabase);
        }
        await removeFixtureCanvases(
          sandbox,
          demoDatabase,
          new Set(seeds.map(([name]) => name)),
        );
        await page.reload();
      }
    }

    // Native confirm dialogs (honest-quit live-work gate, browser-automation
    // grant) cannot be clicked under focus isolation — auto-accept them
    // everywhere. Response index 1 is QUIT_CONFIRM_ACCEPT_INDEX ("quit anyway");
    // the browser grant flow uses the same index for "allow".
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    });

    // Defense in depth: if a window was somehow shown, re-hide Dock and do not
    // activate. Main already applies accessory policy + show:false when
    // JUNTO_E2E=1 without JUNTO_E2E_SHOW.
    if (process.env.JUNTO_E2E_SHOW !== "1") {
      await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        try {
          electronApp.dock?.hide();
        } catch {
          // ignore
        }
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && win.isVisible()) win.hide();
        }
      });
    }

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= cleanupVellumHarness({
        sandbox,
        server,
        application,
      });
      return closePromise;
    };

    return { app, page, sandbox, close };
  } catch (launchError) {
    try {
      await cleanupVellumHarness({
        sandbox,
        server,
        application,
      });
    } catch (cleanupError) {
      const cleanupErrors =
        cleanupError instanceof AggregateError
          ? cleanupError.errors.map(asError)
          : [asError(cleanupError)];
      const preservedSandbox = cleanupErrors.some((error) =>
        error.message.includes(`sandbox preserved at ${sandbox.root}`),
      );
      throw new AggregateError(
        [asError(launchError), ...cleanupErrors],
        preservedSandbox
          ? `Junto e2e launch failed; sandbox preserved at ${sandbox.root}`
          : "Junto e2e launch failed and teardown reported failures",
      );
    }
    throw launchError;
  }
};

// --- Playwright fixture wiring ------------------------------------------------

export interface VellumFixtures {
  vellumOptions: LaunchOptions;
  vellumCommand: VellumHandle;
}

/** Extended `test`: `test.use({ vellumOptions: {...} })` per spec/describe,
 * then destructure `{ vellumCommand: { app, page, sandbox } }` — launch + teardown
 * are owned by the fixture, never by the spec. */
export const test = base.extend<VellumFixtures>({
  vellumOptions: [{}, { option: true }],
  vellumCommand: async ({ vellumOptions }, use) => {
    const handle = await launchVellum(vellumOptions);
    try {
      await use(handle);
    } finally {
      await handle.close();
    }
  },
});

export { expect } from "@playwright/test";
