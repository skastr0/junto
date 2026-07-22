/**
 * Electron launch harness. Wraps the proven playwright-core `_electron`
 * recipe (node runtime only — the Electron driver's launch handshake times
 * out under bun) behind a Playwright fixture so every scenario gets a fully
 * isolated {app, page, sandbox} and guaranteed teardown without hand-rolled
 * try/finally per spec.
 *
 * Isolation invariants (never relaxed):
 *  - throwaway --user-data-dir + VELLUM_CANVASES_DIR per test (sandbox.ts)
 *  - HOME sandboxed to the same temp root + SHELL=/bin/sh, so the adapters'
 *    login-shell PATH probe (src/main/vellum/adapters/exec.ts) cannot
 *    resolve the operator's real CLIs
 *  - renderer served from a local static server (127.0.0.1, ephemeral port)
 *    since the trusted renderer protocol only installs when app.isPackaged
 */
import { lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { test as base, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import type { CanvasDoc } from "../../src/shared/canvas";
import {
  createSandbox,
  destroySandbox,
  writeFixtureCanvas,
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
const MAIN_ENTRY = join(REPO_ROOT, "out/main/index.js");
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
  /** canvas name -> document, written to the sandbox's canvases dir before launch. */
  readonly seedCanvases?: Readonly<Record<string, CanvasDoc>>;
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

// First-run gate (src/renderer/components/StationRoleGate.tsx): a fresh
// sandboxed userData dir has no persisted station.role, so the modal always
// appears. Every scenario needs the canvas interactable, so the harness
// clears it once per launch rather than every spec repeating the same dance.
const dismissStationRoleGate = async (page: Page): Promise<void> => {
  const gate = page.getByRole("dialog", { name: "Choose station role" });
  try {
    await gate.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    return; // no gate this run — fine.
  }
  await page.getByRole("button", { name: /Command Center/ }).first().click();
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

  const requestId = "vellum-e2e-server-shutdown";
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
  for (const [name, doc] of Object.entries(options.seedCanvases ?? {})) {
    await writeFixtureCanvas(sandbox, name, doc);
  }

  const server: RendererServer = await startRendererServer(RENDERER_DIR);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: sandbox.homeDir,
    SHELL: "/bin/sh",
    VELLUM_CANVASES_DIR: sandbox.canvasesDir,
    ELECTRON_RENDERER_URL: server.url,
    ...(options.demo ? { VELLUM_DEMO: "1" } : {}),
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

  const app = await electron.launch({
    executablePath: ELECTRON_BINARY,
    args: [MAIN_ENTRY, `--user-data-dir=${sandbox.userDataDir}`],
    env,
    timeout: 60_000,
  });

  const page = await app.firstWindow();
  await dismissStationRoleGate(page);

  const close = async (): Promise<void> => {
    try {
      await app.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await shutdownSandboxHerdrServer(sandbox);
    } finally {
      await destroySandbox(sandbox);
    }
  };

  return { app, page, sandbox, close };
};

// --- Playwright fixture wiring ------------------------------------------------

export interface VellumFixtures {
  vellumOptions: LaunchOptions;
  vellum: VellumHandle;
}

/** Extended `test`: `test.use({ vellumOptions: {...} })` per spec/describe,
 * then destructure `{ vellum: { app, page, sandbox } }` — launch + teardown
 * are owned by the fixture, never by the spec. */
export const test = base.extend<VellumFixtures>({
  vellumOptions: [{}, { option: true }],
  vellum: async ({ vellumOptions }, use) => {
    const handle = await launchVellum(vellumOptions);
    try {
      await use(handle);
    } finally {
      await handle.close();
    }
  },
});

export { expect } from "@playwright/test";
