import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ModelNodeReader } from "../src/main/junto/node-ref-resolver";
import { ModelStorageError } from "../src/main/junto/model/records";
import { asCanvasName, asNodeId, type Node } from "../src/shared/model";
import { canvasOf, page as pageNode } from "./support/model-nodes";
import { makePageTargetResolver } from "../src/main/junto/browser/page-target";

const page = (id: string, url: string, profile = "personal"): Node =>
  pageNode(id, { url, width: 400, height: 300, profile });

const reader = (held: Readonly<Record<string, ReadonlyArray<Node>>>): ModelNodeReader => ({
  listCanvases: () => Effect.succeed(Object.keys(held).map(asCanvasName)),
  canvas: (name) => held[name] === undefined
    ? Effect.fail(new ModelStorageError({ cause: "missing" }))
    : Effect.succeed(canvasOf(held[name], [], name)),
});

describe("canonical browser page target resolution", () => {
  it("uses the addressed canvas when node ids are duplicated across canvases", async () => {
    const resolve = makePageTargetResolver(
      reader({
        work: [page("same", "https://work.example.com", "work")],
        home: [page("same", "https://home.example.com", "personal")],
      }),
    );
    expect(await resolve("junto://canvas/work?node=same")).toEqual({
      ok: true,
      data: {
        ref: "junto://canvas/work?node=same",
        nodeId: "same",
        url: "https://work.example.com",
        profile: "work",
      },
    });
  });

  it("rejects malformed and noncanonical refs before reading a canvas", async () => {
    const resolve = makePageTargetResolver(reader({ work: [] }));
    for (const ref of [
      "https://canvas/work?node=n1",
      "junto://canvas/WORK?node=n1",
      "junto://canvas/work?node=%6e1",
      { ref: "junto://canvas/work?node=n1" },
    ]) {
      expect(await resolve(ref)).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("returns not_found for a missing canvas or missing node", async () => {
    const resolve = makePageTargetResolver(reader({ work: [] }));
    expect(await resolve("junto://canvas/missing?node=n1")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await resolve("junto://canvas/work?node=n1")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("rejects non-page nodes and invalid browser profiles", async () => {
    const resolve = makePageTargetResolver(
      reader({
        work: [
          { kind: "link", id: asNodeId("plain"), url: "https://plain.example.com", x: 0, y: 0, z: 0, width: 1, height: 1 },
          page("bad-profile", "https://profile.example.com", "../escape"),
        ],
      }),
    );
    for (const id of ["plain", "bad-profile"]) {
      expect(await resolve(`junto://canvas/work?node=${id}`)).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
  });

  it("maps canvas read failures to a typed failed result without leaking details", async () => {
    const failing: ModelNodeReader = {
      listCanvases: () => Effect.succeed([asCanvasName("work")]),
      canvas: () => Effect.fail(new ModelStorageError({ cause: "secret filesystem detail" })),
    };
    expect(await makePageTargetResolver(failing)("junto://canvas/work?node=n1")).toEqual({
      ok: false,
      code: "failed",
      message: "canvas could not be read",
    });
  });
});
