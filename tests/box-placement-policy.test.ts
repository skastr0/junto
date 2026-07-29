import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { placedHostIds } from "../src/main/vellum/box/placement-policy";

describe("Box placement policy", () => {
  it("treats every authored node placement as host demand", () => {
    const document = {
      nodes: [
        {
          id: "remote-note",
          type: "text",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          text: "keep this Box available",
          ether: { host: "box-c79mgja6" },
        },
        {
          id: "local-note",
          type: "text",
          x: 240,
          y: 0,
          width: 200,
          height: 80,
          text: "local",
        },
      ],
      edges: [],
    } satisfies CanvasDoc;

    expect(placedHostIds([document])).toEqual(
      new Set(["box-c79mgja6", "local"]),
    );
  });
});
