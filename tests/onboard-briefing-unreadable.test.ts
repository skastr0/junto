/**
 * A briefing the store cannot read is named as unreadable in onboard, never
 * dropped as if the operator had written none.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  ReferencesPersistenceError,
  ReferencesRepository,
} from "../src/main/junto/references/repository";
import { BRIEFING_UNREADABLE, onboardReferenceFields } from "../src/main/junto/references/seat-reads";

const SEAT = { canvasName: "onboard", nodeId: "agent" };

const storeWith = (briefingRead: ReferencesRepository["Service"]["briefingRead"]) =>
  ({ briefingRead, list: () => Effect.succeed([]), regionTexts: () => Effect.succeed([]) }) as unknown as ReferencesRepository["Service"];

const fieldsWith = (store: ReferencesRepository["Service"]) =>
  Effect.runPromise(onboardReferenceFields(SEAT).pipe(Effect.provideService(ReferencesRepository, store)));

describe("onboard's app briefing", () => {
  it("says the briefing is unreadable when the store cannot read it", async () => {
    const failing = storeWith(() =>
      Effect.fail(new ReferencesPersistenceError({ operation: "briefing.read", message: "disk I/O error", cause: null })),
    );
    expect(await fieldsWith(failing)).toEqual({ briefing: { unreadable: BRIEFING_UNREADABLE } });
  });

  it("carries the body when there is one, and nothing when there is none", async () => {
    expect(await fieldsWith(storeWith(() => Effect.succeed({ body: "Ship 0.10." } as never)))).toEqual({ briefing: "Ship 0.10." });
    expect(await fieldsWith(storeWith(() => Effect.succeed(null)))).toEqual({});
  });
});
