/**
 * Electron launch harness. Wraps the proven playwright-core `_electron`
 * recipe (node runtime only — the Electron driver's launch handshake times
 * out under bun) behind a Playwright fixture so every scenario gets a fully
 * isolated {app, page, sandbox} and guaranteed teardown without hand-rolled
 * try/finally per spec.
 *
 * Isolation invariants (never relaxed):
 *  - throwaway --user-data-dir + HOME per test (sandbox.ts); the app still
 *    resolves its one canonical $HOME/.vellum-command/state/vellum-command.db
 *  - HOME sandboxed to the same temp root + SHELL=/bin/sh, so the adapters'
 *    login-shell PATH probe (src/main/vellum/adapters/exec.ts) cannot
 *    resolve the operator's real CLIs
 *  - renderer served from a local static server (127.0.0.1, ephemeral port)
 *    since the trusted renderer protocol only installs when app.isPackaged
 *  - focus isolation: VELLUM_COMMAND_E2E=1 creates off-screen, non-focusable windows
 *    + accessory Dock policy so Playwright never steals macOS focus. Opt into
 *    a visible window for debugging with VELLUM_COMMAND_E2E_SHOW=1 (not --vellum-headless —
 *    that mode has no authoring renderer at all).
 */
import { lstat, readdir, stat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test as base, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import type { CanvasDoc } from "../../src/shared/canvas";
import type { RemoteHost } from "../../src/shared/remote-hosts";
import {
  createSandbox,
  destroySandbox,
  removeFixtureCanvases,
  writeFixtureCanvas,
  writeFixtureHosts,
  type Sandbox,
} from "./sandbox";
import { startRendererServer, type RendererServer } from "./renderer-server";

// Scripts always invoke playwright from the repo root (package.json
// "test:e2e"/"test:e2e:fast"); resolving from cwd avoids ESM __dirname
// ambiguity under the project's "type": "module".
const REPO_ROOT = process.cwd();
const ELECTRON_BINARY = join(
  REPO_ROOT,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
// Launch with the repo root as the app path (Electron resolves the app dir
// from the main-script's package.json walk): the app must see itself at the
// repo root so resources like scripts/unix-peer-pid.py resolve (process-bind
// identity). Launching `out/main/index.js` directly makes Electron resolve
// the app dir as out/main and every work-socket connection is refused.
const MAIN_ENTRY = REPO_ROOT;
const RENDERER_DIR = join(REPO_ROOT, "out/renderer");

// e2e/fakes/bin/{herdr,ssh,hermes,codexbar} — stock-protocol emulators (see
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
  /** Canvas name -> document, seeded into the sandbox's SQLite database. */
  readonly seedCanvases?: Readonly<Record<string, CanvasDoc>>;
  /** Enrolled fleet rows seeded into the sandbox's explicit SQLite database. */
  readonly seedHosts?: ReadonlyArray<RemoteHost>;
  readonly extraEnv?: Readonly<Record<string, string>>;
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
  readonly shutdownHerdr: (sandbox: Sandbox) => Promise<void>;
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

const defaultCleanupOperations: HarnessCleanupOperations = {
  shutdownHerdr: (sandbox) => shutdownSandboxHerdrServer(sandbox),
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
 * application and child process are terminal and the sandbox-local herdr
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

  let herdrSafe = false;
  try {
    await operations.shutdownHerdr(input.sandbox);
    herdrSafe = true;
  } catch (error) {
    errors.push(contextualError("fake herdr shutdown failed", error));
  }

  if (applicationSafe && herdrSafe) {
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
      ...(herdrSafe ? [] : ["fake herdr termination is unproven"]),
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
        ? `Vellum Command e2e harness cleanup failed; sandbox preserved at ${input.sandbox.root}`
        : "Vellum Command e2e harness cleanup failed",
    );
  }
};

// First-run gate (src/renderer/components/StationRoleGate.tsx): a fresh
// sandboxed userData dir has no persisted station.role, so the modal always
// appears. Every scenario needs the canvas interactable, so the harness
// clears it once per launch rather than every spec repeating the same dance.
const dismissStationRoleGate = async (page: Page): Promise<void> => {
  const gate = page.getByRole("dialog", { name: "Set up this machine" });
  try {
    await gate.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    return; // no gate this run — fine.
  }
  try {
    await gate
      .getByRole("button", { name: /Set up as Command Center/ })
      .first()
      .click({ timeout: 5_000 });
  } catch (error) {
    // Role state can settle between the visibility observation and the click.
    // A gate that already closed reached the same desired state; only surface
    // the click failure while the dialog is still present.
    if (await gate.isHidden()) return;
    throw error;
  }
  await gate.waitFor({ state: "hidden", timeout: 20_000 });
};

// The (fake or real) herdr server is intentionally detached + unref'd by the
// product (src/main/vellum/herdr/plane.ts's startServer) — it's meant to
// outlive any one app session. That's correct product behavior, but an e2e
// sandbox's fake daemon has nothing left to serve once its temp HOME is
// gone; leaving it running leaks a process per test. The fake alone exposes
// an explicit shutdown RPC on this random sandbox socket. No process is ever
// discovered or signaled by pid.
const FAKE_HERDR_SHUTDOWN_TIMEOUT_MS = 2_000;

const socketExists = async (socketPath: string): Promise<boolean> =>
  lstat(socketPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/**
 * Demo-mode apps isolate product state in a process-minted ephemeral SQLite
 * database (src/main/vellum/demo/runtime-isolation.ts): no environment
 * variable can redirect product authority. The seeded sandbox database is
 * therefore invisible to a demo-mode app. After boot the minted file exists
 * under os.tmpdir(); find the newest demo runtime directory so launchVellum
 * can re-seed the same fixtures into it.
 */
const findDemoRuntimeDatabase = async (): Promise<string | undefined> => {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("vellum-command-demo-runtime-"),
      )
      .map(async (entry) => {
        const full = join(tmpdir(), entry.name);
        const info = await stat(full).catch(() => undefined);
        return { full, mtimeMs: info?.mtimeMs ?? 0 };
      }),
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    const database = join(candidate.full, "vellum-command.db");
    if (await socketExists(database)) return database;
  }
  return undefined;
};

const waitForSocketRemoval = async (socketPath: string): Promise<void> => {
  const deadline = Date.now() + FAKE_HERDR_SHUTDOWN_TIMEOUT_MS;
  while (await socketExists(socketPath)) {
    if (Date.now() >= deadline) {
      throw new Error("fake herdr shutdown left its sandbox socket behind");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

export const shutdownSandboxHerdrServer = async (sandbox: Sandbox): Promise<void> => {
  const socketPath = join(sandbox.homeDir, ".config", "herdr", "herdr.sock");
  if (!(await socketExists(socketPath))) return;

  const requestId = "vellum-command-e2e-server-shutdown";
  const acknowledged = await new Promise<boolean>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const settle = (result: { readonly ok: true; readonly acknowledged: boolean } | { readonly ok: false; readonly error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result.ok) resolve(result.acknowledged);
      else reject(result.error);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, error: new Error("fake herdr shutdown RPC timed out") });
    }, FAKE_HERDR_SHUTDOWN_TIMEOUT_MS);

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method: "server.shutdown", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      let response: unknown;
      try {
        response = JSON.parse(buffer.slice(0, lineEnd));
      } catch {
        settle({ ok: false, error: new Error("fake herdr shutdown returned invalid JSON") });
        return;
      }
      const result =
        typeof response === "object" && response !== null
          ? (response as { readonly id?: unknown; readonly result?: unknown })
          : undefined;
      const body =
        typeof result?.result === "object" && result.result !== null
          ? (result.result as { readonly shutting_down?: unknown })
          : undefined;
      if (result?.id !== requestId || body?.shutting_down !== true) {
        settle({ ok: false, error: new Error("fake herdr shutdown returned the wrong acknowledgement") });
        return;
      }
      socket.end();
      settle({ ok: true, acknowledged: true });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        settle({ ok: true, acknowledged: false });
        return;
      }
      settle({ ok: false, error });
    });
  });

  if (!acknowledged) {
    // A stale socket in this throwaway sandbox has no server to unlink it.
    await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await waitForSocketRemoval(socketPath);
};

export const launchVellum = async (options: LaunchOptions = {}): Promise<VellumHandle> => {
  const sandbox = await createSandbox();
  let server: RendererServer | undefined;
  let application: HarnessApplicationState = { kind: "not-launched" };

  try {
    for (const [name, doc] of Object.entries(options.seedCanvases ?? {})) {
      await writeFixtureCanvas(sandbox, name, doc);
    }
    if (options.seedHosts !== undefined) {
      await writeFixtureHosts(sandbox, options.seedHosts);
    }

    server = await startRendererServer(RENDERER_DIR);

    // Drop live seat / work-control env that a factory agent inherits. Spreading
    // process.env would otherwise point the e2e app at the operator's real
    // ~/.vellum-command/work lock (VELLUM_COMMAND_WORK_HOME) and fail work-control startup.
    const inherited = { ...(process.env as Record<string, string>) };
    for (const key of [
      "VELLUM_COMMAND_HOME",
      "VELLUM_COMMAND_WORK_HOME",
      "VELLUM_COMMAND_WORK_SOCKET",
      "VELLUM_COMMAND_SOCKET",
      "VELLUM_COMMAND_NODE_REF",
      "VELLUM_COMMAND_SEAT",
      "VELLUM_COMMAND_TOKEN",
      "VELLUM_COMMAND_WORK_TOKEN",
    ] as const) {
      delete inherited[key];
    }

    const env: Record<string, string> = {
      ...inherited,
      HOME: sandbox.homeDir,
      SHELL: "/bin/sh",
      VELLUM_COMMAND_CANVASES_DIR: sandbox.canvasesDir,
      VELLUM_COMMAND_E2E: "1",
      // Match electron-vite's real development contract exactly. It supplies
      // the loopback authority without a trailing slash; using a normalized
      // test-only URL here previously hid a black-window startup regression.
      ELECTRON_RENDERER_URL: server.url.endsWith("/")
        ? server.url.slice(0, -1)
        : server.url,
      ...(options.demo ? { VELLUM_COMMAND_DEMO: "1" } : {}),
      // Restrict PATH to e2e/fakes/bin + the system floor on every launch — no
      // operator CLI, no real host, no AI tokens. Never opt-in: app boot
      // unconditionally starts the usage-HUD poller (ipc.ts), which shells out
      // to codexbar the moment any scenario window opens, demo or not. This is
      // one of the isolation invariants at the top of this file, not a
      // per-spec choice. `extraEnv.PATH` (if a spec ever sets it) still wins —
      // it's applied after.
      PATH: `${FAKES_BIN_DIR}:${SYSTEM_PATH_FLOOR}`,
      ...options.extraEnv,
    };

    application = { kind: "launch-unobserved" };
    const app = await electron.launch({
      executablePath: ELECTRON_BINARY,
      args: [MAIN_ENTRY, `--user-data-dir=${sandbox.userDataDir}`],
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
        const demoDatabase = await findDemoRuntimeDatabase();
        if (demoDatabase === undefined) {
          throw new Error(
            "demo-mode seed: the app's ephemeral demo database was not found under os.tmpdir()",
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

    await dismissStationRoleGate(page);

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
    // VELLUM_COMMAND_E2E=1 without VELLUM_COMMAND_E2E_SHOW.
    if (process.env.VELLUM_COMMAND_E2E_SHOW !== "1") {
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
          ? `Vellum Command e2e launch failed; sandbox preserved at ${sandbox.root}`
          : "Vellum Command e2e launch failed and teardown reported failures",
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
