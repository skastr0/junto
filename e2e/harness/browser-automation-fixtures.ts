/**
 * Fixtures + helpers for the browser-automation (agent-tools authorization
 * plane) e2e scenarios. Kept separate from harness/sandbox.ts (shared,
 * concurrently-edited infra) so this task only ever adds new files.
 */
import { readFile, rm } from "node:fs/promises";
import type { ElectronApplication } from "playwright-core";
import type { CanvasNode, TextNode } from "../../src/shared/canvas";

/** Eligible chat-agent subject node (browser-automation-ui.ts: kind "agent",
 * name matching `local:[A-Za-z0-9_-]+`) — spawns the fake `hermes` binary via
 * chatRestartWithLocalBrowserAuthority once a grant is approved. */
export const browserAgentNode = (input: {
  readonly id: string;
  readonly agentKey: string;
  readonly label: string;
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 240,
  height: 96,
  ether: { entity: { kind: "agent", name: input.agentKey } },
});

/** A "page" link node — the browser-automation target scope. `url` must
 * pass classifyBrowserTarget (public canonical DNS name, never localhost);
 * the target is never actually navigated to in these scenarios, only used
 * as an authorization-scope target. */
export const browserPageNode = (input: {
  readonly id: string;
  readonly url: string;
  readonly profile: string;
  readonly x?: number;
  readonly y?: number;
}): CanvasNode => ({
  id: input.id,
  type: "link",
  url: input.url,
  x: input.x ?? 300,
  y: input.y ?? 0,
  width: 240,
  height: 80,
  ether: { entity: { kind: "page" }, browser: { profile: input.profile } },
});

export interface CapabilityDump {
  readonly capability: string | null;
  readonly home: string | null;
}

const isCapabilityDump = (value: unknown): value is CapabilityDump =>
  typeof value === "object" &&
  value !== null &&
  "capability" in value &&
  "home" in value &&
  (typeof (value as CapabilityDump).capability === "string" || (value as CapabilityDump).capability === null) &&
  (typeof (value as CapabilityDump).home === "string" || (value as CapabilityDump).home === null);

/** Poll for the fake hermes binary's env dump (FAKE_HERMES_BROWSER_CAPABILITY_DUMP)
 * — the only way this suite observes the capability secret real product code
 * delivers to a spawned local agent child (never to the renderer). */
export const waitForCapabilityDump = async (
  path: string,
  timeoutMs = 30_000,
): Promise<CapabilityDump> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "capability dump not written";
  while (Date.now() < deadline) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (isCapabilityDump(parsed)) return parsed;
      lastError = "capability dump malformed";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`capability dump timed out: ${lastError}`);
};

export const clearCapabilityDump = (path: string): Promise<void> =>
  rm(path, { force: true });

/**
 * Stub the native confirmation dialog (src/main/index.ts confirmBrowserAutomation
 * calls `dialog.showMessageBox(mainWindow, {...})`) so the grant flow can be
 * driven end to end without a real modal.
 *
 * Empirically verified two things this run:
 *  - `require` is NOT a global in the context `app.evaluate`'s pageFunction
 *    runs in (it errors "require is not defined" — evaluate runs as a bare
 *    script, not inside a CJS module wrapper, so the per-module `require`
 *    parameter isn't in scope). `require("electron")` from inside the
 *    evaluate callback does NOT work.
 *  - The `dialog` object Playwright injects as the callback's first
 *    argument DOES take effect against the bundled main process: it is the
 *    same `electron` module singleton `src/main/index.ts`'s
 *    `import { dialog } from "electron"` resolved to (electron-vite bundles
 *    the main process to CJS, so that import is a `require("electron")`
 *    call under the hood; Electron's `electron` module is a native binding,
 *    one singleton per process, and `confirmBrowserAutomation` looks up
 *    `dialog.showMessageBox` at call time — so mutating the property on the
 *    object Playwright hands us patches the exact function index.ts calls).
 */
export const patchBrowserAutomationDialogApproval = (
  app: ElectronApplication,
  response: 0 | 1,
): Promise<void> =>
  app.evaluate(({ dialog }, approve: 0 | 1) => {
    dialog.showMessageBox = (async () => ({
      response: approve,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
  }, response);
