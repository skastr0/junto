import type { TerminalSessionStatus } from "./terminal";

/** Ordered, replayable event on the remote terminal wire. */
export type TerminalEvent =
  | { readonly type: "output"; readonly epoch: string; readonly seq: number; readonly data: string }
  | { readonly type: "resize"; readonly epoch: string; readonly seq: number; readonly cols: number; readonly rows: number }
  | { readonly type: "exit"; readonly epoch: string; readonly seq: number; readonly code?: number; readonly signal?: number };

export type TerminalSnapshot = {
  readonly status: TerminalSessionStatus;
  readonly cols: number;
  readonly rows: number;
  readonly pid?: number;
};

export type RemoteTerminalLease = {
  readonly id: string;
  readonly mode: "control" | "observe";
  readonly expiresAt?: number;
};

/** Atomic attach response: baseline plus ordered events after that baseline. */
export type AttachResponse = {
  readonly epoch: string;
  readonly seq: number;
  readonly snapshot: TerminalSnapshot;
  readonly tail: readonly TerminalEvent[];
  readonly lease: RemoteTerminalLease;
};
