import type { HarnessId } from "./managed-terminal-templates";
import type { MachineHarnessSignIn, MachineKeychainStatus } from "./machine-control";

/** This reports the keychain route only, never whether a credential is valid. */
export const machineHarnessSignIn = (
  harness: HarnessId,
  installed: boolean,
  keychain: MachineKeychainStatus,
): MachineHarnessSignIn => {
  if (!installed) return "not-installed";
  if (keychain === "unavailable" && (harness === "claude" || harness === "codex")) {
    return "keychain-login-unavailable";
  }
  return "sign-in-unverified";
};
