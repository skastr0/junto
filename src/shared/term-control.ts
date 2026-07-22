// Local term control plane: NDJSON over Unix domain socket.
// Every Vellum station (CC or Remote) listens; CC reaches remote stations by
// SSH-forwarding this socket (same pattern as herdr mirror forward).

import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalLaunch, TerminalSessionSummary } from "./terminal";

export const TERM_CONTROL_PROTOCOL = 1 as const;
export const TERM_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export const termControlDir = (home = homedir()): string => join(home, ".vellum", "term");
export const termControlSocketPath = (home = homedir()): string =>
  join(termControlDir(home), "control.sock");
export const termControlTokenPath = (home = homedir()): string =>
  join(termControlDir(home), "token");
/** Relative to remote $HOME — used for SSH unix forward. */
export const TERM_REMOTE_SOCK_REL = ".vellum/term/control.sock";

export type TermControlRequest =
  | { readonly v: 1; readonly id: string; readonly op: "ping" }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "create";
      readonly bindingId: string;
      readonly launch?: TerminalLaunch;
      readonly cols?: number;
      readonly rows?: number;
      readonly canvasName?: string;
      readonly nodeId?: string;
      readonly label?: string;
    }
  | { readonly v: 1; readonly id: string; readonly op: "list" }
  | { readonly v: 1; readonly id: string; readonly op: "get"; readonly bindingId: string }
  | { readonly v: 1; readonly id: string; readonly op: "kill"; readonly bindingId: string }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "bindCanvas";
      readonly bindingId: string;
      readonly ref: { canvasName?: string; nodeId?: string } | null;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "attach";
      readonly bindingId: string;
      readonly mode: "control" | "observe";
      readonly takeover?: boolean;
    }
  | { readonly v: 1; readonly id: string; readonly op: "release"; readonly leaseId: string }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "write";
      readonly leaseId: string;
      readonly data: string;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly op: "resize";
      readonly leaseId: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly v: 1; readonly id: string; readonly op: "shutdown" };

export type TermControlResponse =
  | {
      readonly v: 1;
      readonly id: string;
      readonly ok: true;
      readonly data?: unknown;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly ok: false;
      readonly error: string;
    };

/** Server → client push (after attach). */
export type TermControlEventFrame = {
  readonly v: 1;
  readonly type: "event";
  readonly payload: unknown;
};

export type TermAttachPayload = {
  readonly leaseId: string;
  readonly bindingId: string;
  readonly epoch: string;
  readonly mode: "control" | "observe";
  readonly cols: number;
  readonly rows: number;
  readonly status: string;
  readonly pid?: number;
  readonly journal: readonly unknown[];
};

export type TermListPayload = {
  readonly sessions: readonly TerminalSessionSummary[];
};
