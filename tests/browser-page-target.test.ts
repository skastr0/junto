import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { ModelNodeReader } from "../src/main/junto/node-ref-resolver";
import { ModelStorageError } from "../src/main/junto/model/records";
import { asCanvasName } from "../src/shared/model";
import { canvasFromDocument } from "../src/shared/model/from-document";
import { makePageTargetResolver } from "../src/main/junto/browser/page-target";

const page = (
  id: string,
  url: string,
  profile: string | null = "personal",
  host?: string,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "link",
  url,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  ether: {
    entity: { kind: "page" },
    ...(host === undefined ? {} : { host }),
    ...(profile === null ? {} : { browser: { profile } }),
  },
});

const reader = (docs: Readonly<Record<string, CanvasDoc>>): ModelNodeReader => ({
  listCanvases: () => Effect.succeed(Object.keys(docs).map(asCanvasName)),
  canvas: (name) => docs[name] === undefined
    ? Effect.fail(new ModelStorageError({ cause: "missing" }))
    : Effect.succeed(canvasFromDocument(name, docs[name])),
});

describe("canonical browser page target resolution", () => {
  it("uses the addressed canvas when node ids are duplicated across canvases", async () => {
    const resolve = makePageTargetResolver(
      reader({
        work: { nodes: [page("same", "https://work.example.com", "work")], edges: [] },
        home: { nodes: [page("same", "https://home.example.com", "personal")], edges: [] },
      }),
    );
    expect(await resolve("junto://canvas/work?node=same")).toEqual({
      ok: true,
      data: {
        ref: "junto://canvas/work?node=same",
        nodeId: "same",
        hostId: "local",
        url: "https://work.example.com",
        profile: "work",
      },
    });
  });

  it("derives host affinity from the current page node, including legacy local fallback", async () => {
    const resolve = makePageTargetResolver(
      reader({
        work: {
          nodes: [
            page("legacy", "https://legacy.example.com"),
            page("remote", "https://remote.example.com", "work", "studio"),
          ],
          edges: [],
        },
      }),
    );

    expect(await resolve("junto://canvas/work?node=legacy")).toMatchObject({
      ok: true,
      data: { hostId: "local" },
    });
    expect(await resolve("junto://canvas/work?node=remote")).toMatchObject({
      ok: true,
      data: { hostId: "studio" },
    });
  });

  it("rejects malformed and noncanonical refs before reading a canvas", async () => {
    const resolve = makePageTargetResolver(reader({ work: { nodes: [], edges: [] } }));
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
    const resolve = makePageTargetResolver(reader({ work: { nodes: [], edges: [] } }));
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
        work: {
          nodes: [
            { id: "plain", type: "link", url: "https://plain.example.com", x: 0, y: 0, width: 1, height: 1 },
            {
              id: "text-page",
              type: "text",
              text: "not a browser target",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              ether: { entity: { kind: "page" }, browser: { profile: "personal" } },
            },
            page("unbound", "https://unbound.example.com", null),
            page("bad-profile", "https://profile.example.com", "../escape"),
            page("duplicate", "https://one.example.com"),
            page("duplicate", "https://two.example.com"),
          ],
          edges: [],
        },
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
