import type { VellumApi } from "@shared/ipc";

// `window.vellum` is absent in two legitimate cases: no DOM at all (tests),
// and the preload bridge not having landed a given method yet (a concurrent
// agent is implementing towerBrowse/quasarSearch/agent* on this same IPC
// contract). Every call site treats either as a source-down state — never a
// crash — by routing through this single accessor.
export const getVellumApi = (): VellumApi | undefined =>
  typeof window === "undefined" ? undefined : window.vellum;
