import type { TerminalClient } from "./client";

/**
 * Where this process's PTYs run (protect the main thread, phase 1), chosen by
 * the process's own boot and by nothing else:
 *
 *   - `process`: in the Junto terminal process, through its client. The app's
 *     core chooses this once main hands it the terminal port.
 *   - `here`: in this process. The windowless core chooses this, as does a
 *     unit test.
 *
 * Electron main chooses neither: it holds no PTY, so a spawn there throws
 * instead of running on the main thread. A PTY already spawned stays where it
 * started.
 */
export type TerminalPlace =
  | { readonly kind: "here" }
  | { readonly kind: "process"; readonly client: TerminalClient };

let place: TerminalPlace | undefined;

/** Boot only: where every new PTY in this process runs. */
export const placeTerminals = (next: TerminalPlace): void => {
  place = next;
};

/** Where a new PTY runs; throws in a process whose boot chose no place (Electron main). */
export const terminalPlace = (): TerminalPlace => {
  if (place === undefined) {
    throw new Error("This process holds no terminals: a PTY runs in the Junto terminal process or the core, never on Electron main");
  }
  return place;
};

/** The terminal process's client, when this process's PTYs run there; otherwise none. */
export const terminalProcessClient = (): TerminalClient | undefined => {
  const chosen = terminalPlace();
  return chosen.kind === "process" ? chosen.client : undefined;
};
