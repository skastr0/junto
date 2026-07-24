/**
 * Command Center → enrolled Remote projection push over SshTransport.
 *
 * Product policy renderer: home lookup + named `compileProjectionFrameDeliver`
 * recipe + bounded stdin frame. Never hand-authors remote shell.
 *
 * Residual: packaged apply bridge binary is not required — Remote stations
 * apply `~/.vellum/projections/incoming.frame` on boot (see incoming.ts).
 */

import type { Context } from "effect";
import { Effect } from "effect";
import { decodeRemoteHomeDirectoryOutput } from "../hosts/remote-home";
import {
  makeRemoteStdin,
  parseSshEndpoint,
  SshInputError,
  type SshError,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShotWithStdin } from "../ssh/program";
import { compileProjectionFrameDeliver } from "../ssh/remote-plan";
import { SshTransport } from "../ssh/service";
import type { CompiledStationProjection } from "./compiler";
import type { ProjectionDeliveryTransport } from "./delivery";

type Ssh = Context.Tag.Service<typeof SshTransport>;

const describeDeliveryError = (error: unknown): string => {
  if (error && typeof error === "object" && "_tag" in error) {
    const tagged = error as SshError;
    switch (tagged._tag) {
      case "SshInputError":
        return tagged.message;
      case "SshTimeoutError":
        return `remote projection delivery timed out after ${tagged.timeoutMs}ms`;
      case "SshSpawnError":
        return `remote projection delivery spawn failed: ${tagged.message}`;
      case "SshExitError":
        return `remote projection delivery exited ${tagged.code}`;
      case "SshSetupError":
      case "SshIoError":
      case "SshForwardError":
        return tagged.message;
      case "SshOutputLimitError":
        return `remote projection delivery exceeded ${tagged.limitBytes} byte limit`;
      default:
        return "remote projection delivery failed";
    }
  }
  return error instanceof Error ? error.message : String(error);
};

const isUnreachableError = (error: unknown): boolean => {
  if (!error || typeof error !== "object" || !("_tag" in error)) return false;
  const tag = (error as { _tag: string })._tag;
  return (
    tag === "SshTimeoutError" ||
    tag === "SshSpawnError" ||
    tag === "SshSetupError" ||
    tag === "SshIoError"
  );
};

/**
 * Stage a compiled projection frame at the remote drop path via the named plan.
 */
export const deliverProjectionFrameToEndpoint = (
  ssh: Ssh,
  endpointRaw: string,
  frame: Uint8Array,
): Effect.Effect<
  { readonly path: string; readonly endpoint: string },
  SshError | SshInputError
> =>
  Effect.gen(function* () {
    const endpoint = yield* parseSshEndpoint(endpointRaw);
    yield* ssh.warm(endpoint);
    const homeResult = yield* ssh.run(homeDirectoryLookup(endpoint));
    const remoteHome = decodeRemoteHomeDirectoryOutput(homeResult.stdout);
    if (remoteHome === null) {
      return yield* Effect.fail(
        new SshInputError({
          message:
            "remote home response must be exactly one canonical absolute path followed by LF",
        }),
      );
    }
    const staged = yield* compileProjectionFrameDeliver(remoteHome);
    const input = yield* makeRemoteStdin(frame);
    yield* ssh.run(
      oneShotWithStdin(endpoint, staged.command, input, { budget: "bulk" }),
    );
    return { path: staged.path, endpoint: endpointRaw };
  });

/**
 * Product `scheduleHostSync` transport: enrolled remotes receive frames over
 * SshTransport + `compileProjectionFrameDeliver`.
 */
export const createProjectionDeliveryTransport = (
  ssh: Ssh,
): ProjectionDeliveryTransport => ({
  deliver: async (input: {
    readonly hostId: string;
    readonly endpoint: string;
    readonly compiled: CompiledStationProjection;
  }) => {
    try {
      const result = await Effect.runPromise(
        deliverProjectionFrameToEndpoint(
          ssh,
          input.endpoint,
          input.compiled.frame,
        ),
      );
      return {
        ok: true as const,
        detail: `projection frame staged at ${result.path}`,
      };
    } catch (error) {
      const detail = describeDeliveryError(error).slice(0, 4_096);
      if (isUnreachableError(error)) {
        return {
          ok: false as const,
          status: "unreachable" as const,
          detail,
        };
      }
      return {
        ok: false as const,
        status: "rejected" as const,
        detail,
      };
    }
  },
});
