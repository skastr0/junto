import { ghosttyCapability, type PresentationCapability } from "./ghostty-worker";

export type PresentationBackend = PresentationCapability["id"];

export type PresentationSelection =
  | { readonly ok: true; readonly backend: "xterm" }
  | { readonly ok: false; readonly backend: "ghostty"; readonly reason: string };

export const xtermCapability: PresentationCapability = {
  id: "xterm",
  available: true,
};

/** Select a renderer only; TermPlane remains the process/session authority. */
export const selectPresentation = (
  requested: PresentationBackend = "xterm",
): PresentationSelection => {
  if (requested === "xterm") return { ok: true, backend: "xterm" };
  return {
    ok: false,
    backend: "ghostty",
    reason: ghosttyCapability.reason ?? "Ghostty unavailable",
  };
};
