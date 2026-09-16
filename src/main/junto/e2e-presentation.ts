/**
 * E2E UI presentation: keep Playwright-driven Electron off the operator's
 * macOS focus / Dock while still creating a real BrowserWindow that
 * Playwright can attach to, click, and screenshot.
 *
 * `--junto-headless` is a different mode (no authoring renderer at all).
 * E2E needs a renderer surface; it must simply never steal focus.
 *
 * Opt out of hiding (debug a failing scenario visually):
 *   JUNTO_E2E_SHOW=1 bun run test:e2e:fast e2e/scenarios/...
 */

export interface E2ePresentationInput {
  /** `process.env.JUNTO_E2E === "1"` — harness launches always set this. */
  readonly e2e: boolean;
  /** `process.env.JUNTO_E2E_SHOW === "1"` — operator asked for a visible window. */
  readonly showWindows: boolean;
}

export interface E2eWindowPresentation {
  readonly show: false;
  readonly focusable: false;
  readonly skipTaskbar: true;
}

/** True when the E2E harness is running without an explicit visible-window override. */
export const e2eFocusIsolationActive = (input: E2ePresentationInput): boolean =>
  input.e2e && !input.showWindows;

const E2E_HIDDEN_WINDOW = Object.freeze({
  show: false,
  focusable: false,
  skipTaskbar: true,
}) satisfies E2eWindowPresentation;

const E2E_VISIBLE_WINDOW = Object.freeze({}) satisfies Readonly<
  Record<string, never>
>;

/**
 * BrowserWindow options that keep the authoring surface off-screen and out of
 * the task switcher / Dock. Empty object when not isolating (production or
 * JUNTO_E2E_SHOW=1).
 */
export const e2eMainWindowOptions = (
  input: E2ePresentationInput,
): E2eWindowPresentation | Readonly<Record<string, never>> =>
  e2eFocusIsolationActive(input) ? E2E_HIDDEN_WINDOW : E2E_VISIBLE_WINDOW;

/** Read presentation flags from process env (main-process only). */
export const e2ePresentationFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): E2ePresentationInput => ({
  e2e: env.JUNTO_E2E === "1",
  showWindows: env.JUNTO_E2E_SHOW === "1",
});

/**
 * macOS-only: never become the frontmost app during E2E.
 * `accessory` keeps the process alive without Dock activation policy of a
 * normal GUI app; `dock.hide()` removes the icon that would otherwise appear
 * for every Playwright worker launch.
 */
export const applyE2eMacOsFocusIsolation = (input: {
  readonly active: boolean;
  readonly platform: NodeJS.Platform;
  readonly setActivationPolicy?: (policy: "regular" | "accessory" | "prohibited") => void;
  readonly hideDock?: () => void;
}): void => {
  if (!input.active || input.platform !== "darwin") return;
  try {
    input.setActivationPolicy?.("accessory");
  } catch {
    // Activation policy is best-effort; window show:false still blocks focus.
  }
  try {
    input.hideDock?.();
  } catch {
    // Dock may already be hidden or unavailable in some hosts.
  }
};
