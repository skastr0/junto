import type { CanvasNode } from "@shared/canvas";
import { resolveTerminalBinding, type ResolvedTerminalBinding } from "@shared/terminal";

/**
 * Compatibility boundary for the pre-native herdr terminal surface.
 *
 * Herdr remains fully supported, but new sessions should use TermPlane. Keeping
 * this recognition in a named adapter prevents herdr lifecycle semantics from
 * leaking into the native session host.
 */
export const LEGACY_HERDR_SURFACE = "Herdr (legacy)" as const;

export const resolveLegacyHerdrBinding = (
  node: CanvasNode,
): Extract<ResolvedTerminalBinding, { readonly kind: "herdr" }> | undefined => {
  const binding = resolveTerminalBinding(node);
  return binding?.kind === "herdr" ? binding : undefined;
};
