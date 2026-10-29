/**
 * Move to offers a capture's routes first (11 Q5): in the order suggested,
 * each saying why, the rest after them by name.
 */
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import { matchTargets, moveTargets, suggestedFirst } from "../src/renderer/components/artifacts/artifact-move-model";
import { artifacts, canvasOf, region } from "./support/model-nodes";

const canvas = canvasOf([
  region("product", { x: 0, y: 0, width: 1400, height: 1000 }, { label: "Product" }),
  artifacts("specs", { x: 40, y: 40, label: "Specs" }),
  artifacts("drafts", { x: 600, y: 600, label: "Drafts" }),
  artifacts("shelf", { x: 1600, y: 100, label: "Shelf" }),
  artifacts("inbox", { x: 6000, y: 6000, label: "Inbox" }),
]);
const id = asNodeId;

describe("Move to's suggestions", () => {
  it("puts the suggested nodes first, in their order, and drops one that is not a target", () => {
    const targets = suggestedFirst(moveTargets(canvas, id("inbox")), [
      { nodeId: id("shelf"), why: "Artifacts like it are here" },
      { nodeId: id("inbox"), why: "never: it is where the capture is" },
      { nodeId: id("specs"), why: "Its labels are used here" },
    ]);
    expect(targets).toEqual([
      { id: "shelf", title: "Shelf", place: "No region", suggested: "Artifacts like it are here" },
      { id: "specs", title: "Specs", place: "Product", suggested: "Its labels are used here" },
      { id: "drafts", title: "Drafts", place: "Product" },
    ]);
  });

  it("keeps a suggestion first while what is typed still matches it", () => {
    const targets = suggestedFirst(moveTargets(canvas, id("inbox")), [{ nodeId: id("specs"), why: "x" }]);
    expect(matchTargets(targets, "product").map((target) => target.id)).toEqual(["specs", "drafts"]);
  });
});
