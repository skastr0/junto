import { Effect } from "effect";
import type { MachineKeychainStatus } from "@shared/machine-control";
import { runProcess } from "../../services/process";

interface MachineKeychainProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly run?: typeof runProcess;
}

/** Only keychain metadata is queried; no password or harness command is run. */
export const detectMachineKeychain = (
  options: MachineKeychainProbeOptions = {},
): Effect.Effect<MachineKeychainStatus> => (options.platform ?? process.platform) !== "darwin"
  ? Effect.succeed("not-applicable")
  : Effect.tryPromise(() => (options.run ?? runProcess)("/usr/bin/security", ["show-keychain-info"], {
    timeoutMs: 2_000, maxOutputBytes: 8_192,
  })).pipe(
    Effect.map(result => result.code === 0 ? "available" as const : "unavailable" as const),
    Effect.catch(() => Effect.succeed("unavailable" as const)),
  );
