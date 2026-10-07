import { describe, expect, it } from "vitest";
import {
  actorRefResolverFromProjection,
  regionDisplayName,
  UNNAMED_REGION,
} from "../src/shared/graph";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";

describe("regionDisplayName", () => {
  const group = (label?: string) =>
    ({ id: "g", type: "group", x: 0, y: 0, width: 10, height: 10, ...(label === undefined ? {} : { label }) }) as const;

  it("is the trimmed label whenever the label has any text", () => {
    for (const label of ["PTY", "  forge  ", "0", "x", "false", "unnamed", "\tOps\n"]) {
      expect(regionDisplayName(group(label))).toBe(label.trim());
      expect(regionDisplayName(group(label))).not.toBe(UNNAMED_REGION);
    }
  });

  it("is the one placeholder only when the label is absent, empty or blank", () => {
    for (const label of [undefined, "", "   ", "\n\t"]) {
      expect(regionDisplayName(group(label))).toBe("unnamed region");
    }
  });
});

describe("graph derivations", () => {
  it("projection resolver fails closed for duplicate canvas-local actor refs", () => {
    const first = actorRefFixture("a1");
    const duplicate = {
      ...actorRefFixture("other"),
      canvasName: first.canvasName,
      nodeId: first.nodeId,
    };
    const resolve = actorRefResolverFromProjection([first, duplicate]);

    expect(
      resolve({ canvasName: first.canvasName, nodeId: first.nodeId }),
    ).toBeUndefined();
  });
});
