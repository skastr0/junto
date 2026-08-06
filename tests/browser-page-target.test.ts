import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { CanvasNodeReader } from "../src/main/vellum/node-ref-resolver";
import { CanvasError } from "../src/main/vellum/canvases";
import { makePageTargetResolver } from "../src/main/vellum/browser/page-target";

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

const reader = (docs: Readonly<Record<string, CanvasDoc>>): CanvasNodeReader => ({
  list: Effect.succeed(
    Object.keys(docs).map((name) => ({
      name,
      modifiedAt: "2026-07-17T00:00:00.000Z",
    })),
  ),
  read: (name) => {
    const doc = docs[name];
    return doc === undefined
      ? Effect.fail(new CanvasError({ message: "missing" }))
      : Effect.succeed({
          name,
          doc,
          actorRefs: [],
          revision: `${name}-r1`,
          workRevision: "0",
        });
  },
});

describe("canonical browser page target resolution", () => {
  it("uses the addressed canvas when node ids are duplicated across canvases", async () => {
    const resolve = makePageTargetResolver(
      reader({
        work: { nodes: [page("same", "https://work.example.com", "work")], edges: [] },
        home: { nodes: [page("same", "https://home.example.com", "personal")], edges: [] },
      }),
    );
    expect(await resolve("vellum-command://canvas/work?node=same")).toEqual({
      ok: true,
      data: {
        ref: "vellum-command://canvas/work?node=same",
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

    expect(await resolve("vellum-command://canvas/work?node=legacy")).toMatchObject({
      ok: true,
      data: { hostId: "local" },
    });
    expect(await resolve("vellum-command://canvas/work?node=remote")).toMatchObject({
      ok: true,
      data: { hostId: "studio" },
    });
  });

  it("rejects malformed and noncanonical refs before reading a canvas", async () => {
    const resolve = makePageTargetResolver(reader({ work: { nodes: [], edges: [] } }));
    for (const ref of [
      "https://canvas/work?node=n1",
      "vellum-command://canvas/WORK?node=n1",
      "vellum-command://canvas/work?node=%6e1",
      { ref: "vellum-command://canvas/work?node=n1" },
    ]) {
      expect(await resolve(ref)).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("returns not_found for a missing canvas or missing node", async () => {
    const resolve = makePageTargetResolver(reader({ work: { nodes: [], edges: [] } }));
    expect(await resolve("vellum-command://canvas/missing?node=n1")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await resolve("vellum-command://canvas/work?node=n1")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("rejects non-page, non-link, unbound, invalid-profile, and duplicate targets", async () => {
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
    for (const id of ["plain", "text-page", "unbound", "bad-profile", "duplicate"]) {
      expect(await resolve(`vellum-command://canvas/work?node=${id}`)).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
  });

  it("maps canvas read failures to a typed failed result without leaking details", async () => {
    const failing: CanvasNodeReader = {
      list: Effect.succeed([
        { name: "work", modifiedAt: "2026-07-17T00:00:00.000Z" },
      ]),
      read: () => Effect.fail(new CanvasError({ message: "secret filesystem detail" })),
    };
    expect(await makePageTargetResolver(failing)("vellum-command://canvas/work?node=n1")).toEqual({
      ok: false,
      code: "failed",
      message: "canvas could not be read",
    });
  });
});
