/**
 * The window's authority read (0.11/06 F5): one store for every canvas this
 * machine holds, built from the IPC read and refreshed when main says it
 * changed. The words and the view come from @shared/authority, so the banner,
 * the status command and the tests cannot drift.
 */
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { AUTHORITY_ENABLED } from "@shared/features";
import {
  authorityViewOf,
  type AuthorityMachineFacts,
  type AuthorityRead,
  type AuthorityView,
} from "@shared/authority";
import { seatStatusTime } from "@shared/seat-status-text";

export const authority$ = observable<{
  machines: ReadonlyArray<AuthorityMachineFacts>;
  canvases: Readonly<Record<string, AuthorityRead>>;
}>({ machines: [], canvases: {} });

/** Read every canvas's authority again; a build with the authority off reads nothing. */
export const refreshAuthority = async (): Promise<void> => {
  if (!AUTHORITY_ENABLED) return;
  const data = await window.junto?.authorityRead?.().catch(() => null);
  if (data === null || data === undefined) return;
  authority$.machines.set(data.machines);
  authority$.canvases.set(Object.fromEntries(data.canvases.map((read) => [read.canvas, read])));
};

/** Follow main's change notice; returns its unsubscribe. */
export const followAuthority = (): (() => void) => {
  if (!AUTHORITY_ENABLED) return () => {};
  void refreshAuthority();
  return window.junto?.onAuthorityChanged?.(() => void refreshAuthority()) ?? (() => {});
};

/** The one view for a canvas, or undefined while this machine has not read it. */
export const useAuthorityView = (canvasName: string | undefined): AuthorityView | undefined => {
  const reads = use$(authority$.canvases);
  const machines = use$(authority$.machines);
  if (canvasName === undefined) return undefined;
  const read = reads[canvasName];
  return read === undefined ? undefined : authorityViewOf(read, machines);
};

/** A time in the contract's words: the clock today, the day and the clock before. */
export const authorityWhen = (at: number): string => seatStatusTime(at, Date.now());
