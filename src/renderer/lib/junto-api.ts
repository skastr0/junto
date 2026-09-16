import type {
  JuntoApi,
  JuntoGitApi,
  JuntoHostsApi,
  JuntoTerminalApi,
} from "@shared/ipc";

// `window.junto` is absent in two legitimate cases: no DOM at all (tests),
// and the preload bridge not having landed a given method yet (a concurrent
// agent* IPC methods share this surface
// contract). Every call site treats either as a source-down state — never a
// crash — by routing through this single accessor.
export const getJuntoApi = ():
  | (JuntoApi &
      Partial<JuntoTerminalApi> &
      Partial<JuntoGitApi> &
      Partial<JuntoHostsApi>)
  | undefined =>
  typeof window === "undefined" ? undefined : window.junto;
