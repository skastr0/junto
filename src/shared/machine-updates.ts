import { machineUpdateDirection, type MachineRelease } from "./machine-control";

export type MachineUpdateFacts = {
  /** The build the peer last said it runs, from a hello this machine admitted. */
  readonly peerBuild: string | undefined;
  /** This machine's own build; the only bytes an automatic pass may install. */
  readonly ownBuild: string;
  readonly peerRelease: MachineRelease;
  readonly ownRelease: MachineRelease;
  /** Seats running on the far machine, if its own status answered. */
  readonly runningSeats: number | undefined;
  /** A canvas this machine holds names that machine as its editor. */
  readonly editedHere: boolean;
  /** A failed attempt for this target build is already on file. */
  readonly latchedForBuild: boolean;
  readonly downloadsBundles: boolean;
  readonly signedRelease: boolean;
};

export type MachineUpdateDecision =
  | { readonly kind: "skip"; readonly reason: "same-build" | "unknown-build" | "editor" | "latched" }
  | { readonly kind: "click"; readonly reason: "running-seats" | "unknown-seats" }
  | { readonly kind: "tell"; readonly reason: "this-older" | "needs-signed-release" }
  | { readonly kind: "update" };

/**
 * One automatic pass for one peer. A peer's claim only decides whether to
 * push; the installed bytes are always this machine's own build or a signed
 * release. Running seats keep the operator's click, and the far count only
 * saves the transfer, never replaces the install lease.
 */
export const decideMachineUpdate = (facts: MachineUpdateFacts): MachineUpdateDecision => {
  if (facts.peerBuild === undefined) return { kind: "skip", reason: "unknown-build" };
  if (facts.peerBuild === facts.ownBuild) return { kind: "skip", reason: "same-build" };
  if (facts.editedHere) return { kind: "skip", reason: "editor" };
  if (facts.runningSeats === undefined) return { kind: "click", reason: "unknown-seats" };
  if (facts.runningSeats > 0) return { kind: "click", reason: "running-seats" };
  if (facts.latchedForBuild) return { kind: "skip", reason: "latched" };
  if (machineUpdateDirection(facts.peerRelease, facts.ownRelease) === "this-older") {
    return { kind: "tell", reason: "this-older" };
  }
  if (facts.downloadsBundles && !facts.signedRelease) {
    return { kind: "tell", reason: "needs-signed-release" };
  }
  return { kind: "update" };
};
