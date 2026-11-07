/**
 * The observability group (src/contract/core/observability.ts) through the
 * group's own client on the core's handlers: the ring captures every row, a
 * new entry is pushed only while a panel watches, a clear is told to a
 * watching panel, and main's own rows land in the core's ring. A panel's
 * query this build does not read asks for the ring unfiltered, at main's edge.
 */
import { Effect, Exit, Layer, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { describe, expect, it } from "vitest";
import { OBSERVABILITY_CLEARED, OBSERVABILITY_LOG } from "../src/contract/core/channels";
import { ObservabilityRpcs } from "../src/contract/core/observability";
import { ObservabilityHandlers } from "../src/core/ops/observability";
import { observabilityRing } from "../src/core/observability/ring";
import { CorePushes } from "../src/core/push";
import { observabilityQueryFromWindow } from "../src/shared/observability";

describe("the observability group", () => {
  it("pushes a new entry only while a panel watches, tells a watching panel of a clear, and stops with the server", async () => {
    const pushed: Array<readonly [string, unknown]> = [];
    const scope = await Effect.runPromise(Scope.make());
    const handlers = await Effect.runPromise(
      Layer.buildWithScope(
        ObservabilityHandlers.pipe(
          Layer.provide(Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushed.push([channel, payload])) })),
        ),
        scope,
      ),
    );
    const client = await Effect.runPromise(
      RpcTest.makeClient(ObservabilityRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
    );

    await Effect.runPromise(client.ObservabilityAppend({ entry: { level: "info", source: "main", message: "unwatched" } }));
    expect(pushed).toEqual([]);

    await Effect.runPromise(client.ObservabilityWatch());
    await Effect.runPromise(client.ObservabilityAppend({ entry: { level: "info", source: "main", message: "watched" } }));
    expect(pushed.map(([channel]) => channel)).toEqual([OBSERVABILITY_LOG]);
    expect((await Effect.runPromise(client.ObservabilityQuery({ query: { q: "watched", limit: 10 } }))).entries.map((entry) => entry.message))
      .toContain("watched");

    await Effect.runPromise(client.ObservabilityClear());
    expect(pushed.map(([channel]) => channel)).toEqual([OBSERVABILITY_LOG, OBSERVABILITY_CLEARED]);

    await Effect.runPromise(client.ObservabilityUnwatch());
    await Effect.runPromise(client.ObservabilityAppend({ entry: { level: "info", source: "main", message: "closed panel" } }));
    expect(pushed).toHaveLength(2);

    await Effect.runPromise(client.ObservabilityWatch());
    await Effect.runPromise(Scope.close(scope, Exit.void));
    observabilityRing.append({ level: "info", source: "main", message: "after the server" });
    expect(pushed).toHaveLength(2);
  });

  it("reads a panel's query at main's edge, and asks for the ring unfiltered for one this build does not read", () => {
    expect(observabilityQueryFromWindow({ limit: 500, q: undefined, levels: ["fatal"] })).toEqual({ limit: 500, levels: ["fatal"] });
    expect(observabilityQueryFromWindow({ limit: 500, nope: true })).toBeUndefined();
    expect(observabilityQueryFromWindow(null)).toBeUndefined();
  });
});
