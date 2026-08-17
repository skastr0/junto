import type { StationRoleSetting } from "@shared/settings";

export type CanvasBootAction =
  | { readonly kind: "open"; readonly name: string }
  | { readonly kind: "seed" }
  | { readonly kind: "wait-projection" };

/**
 * Remote consumes Command Center projection and must never seed or create.
 * Command Center still seeds an empty authorial install.
 */
export const nextCanvasBootAction = (
  role: StationRoleSetting,
  names: ReadonlyArray<string>,
): CanvasBootAction => {
  const first = names[0];
  if (first !== undefined) return { kind: "open", name: first };
  if (role === "command-center") return { kind: "seed" };
  return { kind: "wait-projection" };
};

export const isCommandCenterAuthoring = (role: StationRoleSetting): boolean =>
  role === "command-center";

/** Command Fleet is Command Center chrome. A Remote must not open it. */
export const isCommandCenterFleetUi = (role: StationRoleSetting): boolean =>
  role === "command-center";
