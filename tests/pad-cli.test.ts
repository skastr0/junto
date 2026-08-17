import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { loadJsonInput } from "../src/cli/core/json";
import {
  callerNodeIdFromCapabilities,
  decodePadReadResult,
  projectPadDigest,
  projectPadGet,
  projectPadLookHere,
  projectPadSvg,
  projectPadTagged,
} from "../src/cli/core/pad";
import {
  applyPatches,
  emptyPad,
  PadPatch,
  type Pad,
  type PadError,
} from "../src/shared/pad";
import {
  PadGetArgs,
  PadLookHereArgs,
  PadPatchArgs,
  PadReadArgs,
  PadTargetArgs,
} from "../src/shared/work-control";

const decodePatch = (patch: unknown): PadPatch =>
  Schema.decodeUnknownSync(PadPatch)(patch);

const expectOk = (result: Result.Result<Pad, PadError>): Pad => {
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

const fixture = (): Pad =>
  expectOk(
    applyPatches(emptyPad(), [
      decodePatch({
        op: "upsert",
        layer: "shape",
        shape: {
          id: "box-1",
          type: "box",
          x: 0,
          y: 0,
          w: 80,
          h: 40,
          z: 0,
          text: "inbox",
        },
      }),
      decodePatch({
        op: "pin.upsert",
        pin: { id: "pin-1", x: 16, y: 16, mentions: ["agent-1"] },
      }),
      decodePatch({
        op: "pin.upsert",
        pin: { id: "pin-2", x: 40, y: 40, mentions: ["other"] },
      }),
    ]),
  );

const readOf = (pad: Pad) => ({
  revision: pad.revision,
  pad,
  digest: "pad :: revision=1",
  svg: "<svg></svg>",
});

describe("pad CLI input schemas", () => {
  it("decodes each verb and refuses excess fields", async () => {
    await expect(
      Effect.runPromise(loadJsonInput(PadReadArgs, '{"target":"pad-1"}')),
    ).resolves.toEqual({ target: "pad-1" });
    await expect(
      Effect.runPromise(
        loadJsonInput(PadLookHereArgs, '{"target":"pad-1","pinId":"pin-1"}'),
      ),
    ).resolves.toEqual({ target: "pad-1", pinId: "pin-1" });
    await expect(
      Effect.runPromise(loadJsonInput(PadLookHereArgs, '{"target":"pad-1"}')),
    ).rejects.toThrow(/pinId/i);
    await expect(
      Effect.runPromise(
        loadJsonInput(PadGetArgs, '{"target":"pad-1","id":"box-1"}'),
      ),
    ).resolves.toEqual({ target: "pad-1", id: "box-1" });
    await expect(
      Effect.runPromise(
        loadJsonInput(PadTargetArgs, '{"target":"pad-1","extra":true}'),
      ),
    ).rejects.toThrow(/extra|unexpected/i);

    const patch = await Effect.runPromise(
      loadJsonInput(
        PadPatchArgs,
        JSON.stringify({
          target: "pad-1",
          patches: [
            {
              op: "upsert",
              layer: "shape",
              shape: {
                id: "box-1",
                type: "box",
                x: 0,
                y: 0,
                w: 80,
                h: 40,
                z: 0,
              },
            },
          ],
        }),
      ),
    );
    expect(patch.patches).toHaveLength(1);
  });
});

describe("pad CLI projections", () => {
  it("projects digest, svg, look-here, get, and tagged", () => {
    const pad = fixture();
    const read = readOf(pad);
    expect(projectPadDigest(read)).toEqual({
      revision: pad.revision,
      digest: read.digest,
    });
    expect(projectPadSvg(read)).toEqual({
      revision: pad.revision,
      svg: read.svg,
    });

    const crop = projectPadLookHere(read, "pin-1");
    expect(Result.isSuccess(crop)).toBe(true);
    if (Result.isSuccess(crop)) {
      expect(crop.success.pinId).toBe("pin-1");
      expect(crop.success.digest).toContain("look-here :: pin-1");
      expect(crop.success.svg).toContain("<svg");
    }
    expect(Result.isFailure(projectPadLookHere(read, "missing"))).toBe(true);

    const all = projectPadGet(read);
    expect(Result.isSuccess(all)).toBe(true);
    if (Result.isSuccess(all)) {
      expect(all.success.items.map((item) => item.id)).toEqual(
        expect.arrayContaining(["box-1", "pin-1"]),
      );
    }
    const one = projectPadGet(read, "box-1");
    expect(Result.isSuccess(one)).toBe(true);
    if (Result.isSuccess(one)) {
      expect(one.success.items).toHaveLength(1);
      expect(one.success.items[0]?.id).toBe("box-1");
    }
    expect(Result.isFailure(projectPadGet(read, "nope"))).toBe(true);

    expect(projectPadTagged(read, "agent-1").pins.map((pin) => pin.id)).toEqual([
      "pin-1",
    ]);
    expect(projectPadTagged(read, "nobody").pins).toEqual([]);
  });

  it("decodes pad.read payloads and reads the process-bound seat id", () => {
    const pad = fixture();
    const decoded = decodePadReadResult(readOf(pad));
    expect(Result.isSuccess(decoded)).toBe(true);
    expect(
      Result.isFailure(decodePadReadResult({ revision: 1, digest: "x" })),
    ).toBe(true);
    expect(
      callerNodeIdFromCapabilities({
        node: { id: "agent-1", kind: "agent" },
        connected: [],
      }),
    ).toBe("agent-1");
    expect(callerNodeIdFromCapabilities({})).toBeUndefined();
  });
});
