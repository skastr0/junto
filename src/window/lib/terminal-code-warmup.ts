import { Terminal } from "@xterm/xterm";
import { JUNTO_XTERM_FONT_FAMILY, JUNTO_XTERM_FONT_SIZE } from "./terminal-theme";

/**
 * Warm xterm's code path on the first idle after boot.
 *
 * The first grid open is 285 ms of native V8 work (a CPU profile shows no JS
 * frames: the compiler is optimizing xterm's Terminal/open/write path on
 * first use). A detached, invisible Terminal with no WebGL addon, no pty and
 * no focus runs that path once while the window is idle, so the operator's
 * first open does not pay the compile. It shares no context and shows nothing.
 */
const warmOnce = (): Promise<number> => new Promise((done) => {
  const started = performance.now();
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:800px;height:400px;opacity:0;pointer-events:none;contain:strict;";
  document.body.append(host);
  let term: Terminal | undefined;
  const finish = (): void => {
    try {
      term?.dispose();
    } catch {
      // A warm-up must never break boot.
    }
    host.remove();
    done(performance.now() - started);
  };
  try {
    term = new Terminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      fontFamily: JUNTO_XTERM_FONT_FAMILY,
      fontSize: JUNTO_XTERM_FONT_SIZE,
    });
    term.open(host);
    term.write("warm\n", () => {
      try {
        term?.refresh(0, term.rows - 1);
      } catch {
        // The parse path is what matters; a disposed renderer is fine.
      }
      requestAnimationFrame(finish);
    });
  } catch {
    finish();
  }
});

/** One idle pass across the app lifetime; the mark pair is the receipt. */
export const scheduleTerminalCodeWarmup = (): void => {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const run = (): void => {
    performance.mark("terminal-warmup-start");
    void warmOnce().then((ms) => {
      performance.mark("terminal-warmup-end");
      performance.measure("terminal-warmup", "terminal-warmup-start", "terminal-warmup-end");
      if (import.meta.env.MODE !== "production") console.debug(`terminal warm-up ${ms.toFixed(0)}ms`);
    });
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 2_000 });
  else setTimeout(run, 0);
};
