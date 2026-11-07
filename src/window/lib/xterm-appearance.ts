import type { Terminal } from "@xterm/xterm";
import type { ThemeMode } from "@shared/theme";
import { schemeDsrFor } from "@shared/theme";
import { xtermThemeFor } from "./terminal-theme";

/**
 * Live appearance protocol for Junto terminals.
 *
 * - OSC 10/11/12: xterm.js already reports/sets from the loaded ITheme once
 *   `xtermThemeFor` is applied — no custom OSC handlers required.
 * - CSI ?996 n: query dark/light preference → reply CSI ?997;1n | ?997;2n.
 * - CSI ?2031 h/l: subscribe / unsubscribe to unsolicited scheme reports.
 * - DECRQM CSI ?2031 $ p: report whether subscription is set.
 * - On themeMode change: re-apply ITheme and, when subscribed, emit ?997;…
 *
 * Replies go through `term.input` so they ride the same onData → PTY write path
 * as keyboard input (colour reports from xterm use the same channel).
 *
 * Policy:
 * - `follow` (default): re-apply Junto theme on every mode flip.
 * - `agent`: still answer protocol queries; skip forced theme re-apply so an
 *   agent that painted its own palette is not overwritten mid-session.
 */

export type AgentAppearancePolicy = "follow" | "agent";

export type XtermAppearanceHandle = {
  readonly dispose: () => void;
  /** Apply a new mode (theme + optional live DSR). */
  readonly setMode: (mode: ThemeMode) => void;
  readonly setPolicy: (policy: AgentAppearancePolicy) => void;
  /** Whether CSI ?2031 subscription is currently on. */
  readonly isSubscribed: () => boolean;
};

const flatParams = (
  params: ReadonlyArray<number | number[]>,
): readonly number[] => {
  const out: number[] = [];
  for (const p of params) {
    if (typeof p === "number" && Number.isFinite(p)) out.push(p);
    else if (Array.isArray(p)) {
      for (const n of p) {
        if (typeof n === "number" && Number.isFinite(n)) out.push(n);
      }
    }
  }
  return out;
};

const reply = (term: Terminal, sequence: string): void => {
  try {
    // wasUserInput=false: protocol reply, not a keystroke.
    term.input(sequence, false);
  } catch {
    // Terminal mid-dispose — drop the reply.
  }
};

export const attachXtermAppearance = (
  term: Terminal,
  options: {
    readonly initialMode: ThemeMode;
    readonly policy?: AgentAppearancePolicy;
  },
): XtermAppearanceHandle => {
  let mode: ThemeMode = options.initialMode;
  let policy: AgentAppearancePolicy = options.policy ?? "follow";
  let subscribed = false;
  const disposables: Array<{ dispose: () => void }> = [];

  // CSI ? 996 n — colour-scheme query.
  disposables.push(
    term.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      const modes = flatParams(params);
      if (!modes.includes(996)) return false;
      reply(term, schemeDsrFor(mode));
      return true;
    }),
  );

  // CSI ? 2031 h — enable unsolicited scheme reports.
  disposables.push(
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (!flatParams(params).includes(2031)) return false;
      subscribed = true;
      // Immediate report so clients that enable then wait get a first sample.
      reply(term, schemeDsrFor(mode));
      return false; // let other handlers / xterm see co-packed modes
    }),
  );

  // CSI ? 2031 l — disable unsolicited scheme reports.
  disposables.push(
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (!flatParams(params).includes(2031)) return false;
      subscribed = false;
      return false;
    }),
  );

  // DECRQM CSI ? 2031 $ p — report mode 2031 set/reset (Ps: 1=set, 2=reset).
  disposables.push(
    term.parser.registerCsiHandler(
      { prefix: "?", intermediates: "$", final: "p" },
      (params) => {
        const modes = flatParams(params);
        if (!modes.includes(2031)) return false;
        const ps = subscribed ? 1 : 2;
        reply(term, `\x1b[?2031;${ps}$y`);
        return true;
      },
    ),
  );

  const setMode = (next: ThemeMode): void => {
    const changed = next !== mode;
    mode = next;
    if (policy === "follow") {
      try {
        term.options.theme = xtermThemeFor(mode);
      } catch {
        // ignore dispose races
      }
    }
    if (changed && subscribed) {
      reply(term, schemeDsrFor(mode));
    }
  };

  const setPolicy = (next: AgentAppearancePolicy): void => {
    policy = next;
    if (policy === "follow") {
      try {
        term.options.theme = xtermThemeFor(mode);
      } catch {
        // ignore
      }
    }
  };

  return {
    dispose: () => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }
      disposables.length = 0;
    },
    setMode,
    setPolicy,
    isSubscribed: () => subscribed,
  };
};
