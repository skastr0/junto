import type {
  VellumCommandApi,
  VellumCommandGitApi,
  VellumCommandHostsApi,
  VellumCommandTerminalApi,
} from "@shared/ipc";

// `window.vellumCommand` is absent in two legitimate cases: no DOM at all (tests),
// and the preload bridge not having landed a given method yet (a concurrent
// agent* IPC methods share this surface
// contract). Every call site treats either as a source-down state — never a
// crash — by routing through this single accessor.
export const getJuntoApi = ():
  | (VellumCommandApi &
      Partial<VellumCommandTerminalApi> &
      Partial<VellumCommandGitApi> &
      Partial<VellumCommandHostsApi>)
  | undefined =>
  typeof window === "undefined" ? undefined : window.vellumCommand;
