/**
 * The core's handlers of the status group (src/contract/core/status.ts): the
 * authority banner, a canvas digest, usage, and the kernel snapshot. Each
 * answer is plain data; the authority read answers null when the plane is off
 * or cannot be read, as it did on main.
 */
import { Effect, Option } from "effect";
import type { AuthorityWindowData } from "@shared/authority";
import { AUTHORITY_ENABLED } from "@shared/features";
import { StatusRpcs, StatusUnavailable } from "../../contract/core/status";
import { CanvasAuthorities } from "../fleet/authorities";
import { KernelService } from "../kernel/service";
import { readModelDigest } from "../model/digest";
import { UsageService } from "../usage/usage-service";

/** A digest that could not be read, in its own words, or its tag when it has none. */
const unavailable = (error: unknown): StatusUnavailable => {
  const message = error instanceof Error ? error.message : String(error);
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "the digest could not be read";
  return new StatusUnavailable({ message: message.length > 0 ? message : tag });
};

export const StatusHandlers = StatusRpcs.toLayer({
  StatusAuthority: () =>
    Effect.gen(function* () {
      if (!AUTHORITY_ENABLED) return null;
      const host = yield* Effect.serviceOption(CanvasAuthorities);
      if (Option.isNone(host)) return null;
      const machines = yield* host.value.machines();
      const canvases = yield* host.value.status();
      return { self: machines.self, machines: machines.machines, canvases } satisfies AuthorityWindowData;
    }).pipe(Effect.catch(() => Effect.succeed(null))),
  StatusDigest: ({ name }) => readModelDigest(name).pipe(Effect.map((digest) => ({ digest })), Effect.mapError(unavailable)),
  StatusUsageCurrent: () => Effect.flatMap(UsageService, (usage) => usage.current),
  StatusUsageRefresh: () => Effect.flatMap(UsageService, (usage) => usage.refresh()),
  StatusKernel: () => Effect.map(KernelService, (kernel) => kernel.getSnapshot()),
});
