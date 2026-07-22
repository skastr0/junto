export type PresentationCapability = {
  readonly id: "xterm" | "ghostty";
  readonly available: boolean;
  readonly reason?: string;
};

/**
 * Path B gates: a shipped, signed worker; stable libghostty embedding API;
 * sandbox-safe IPC/frame transport; input/IME/accessibility parity; and crash
 * isolation. Until every gate is met, Ghostty cannot own a presentation.
 */
export const ghosttyCapability: PresentationCapability = {
  id: "ghostty",
  available: false,
  reason: "Ghostty worker is reserved for Path B and is not available",
};
