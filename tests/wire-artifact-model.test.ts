/**
 * The artifact model is a wire model (0.11.3, the phone's artifacts): its
 * schemas and rules live in src/shared/wire/ with an `effect`-only closure
 * (tests/wire-closure.test.ts), and every desktop path that held them
 * re-exports the very same value. So the phone decodes and rules a write with
 * the schema and the function the Mac uses, not a copy that can drift.
 */
import { describe, expect, it } from "vitest";
import * as actorSeat from "../src/shared/actor-seat";
import { Schema } from "effect";
import * as artifact from "../src/shared/artifact";
import * as labels from "../src/shared/artifact-labels";
import * as mention from "../src/shared/mention";
import * as modelSheet from "../src/shared/model/sheet";
import * as pad from "../src/shared/pad";
import * as padProject from "../src/shared/pad-project";
import * as physics from "../src/shared/physics/schema";
import * as resourceCommand from "../src/shared/resource-command";
import * as sheet from "../src/shared/sheet";
import * as canvasName from "../src/shared/canvas-name";
import * as nodeRef from "../src/shared/node-ref";
import * as ulid from "../src/shared/ulid";
import * as workIds from "../src/shared/work-ids";
import * as wireArtifact from "../src/shared/wire/artifact";
import * as wireIds from "../src/shared/wire/ids";
import * as wireLabels from "../src/shared/wire/artifact-labels";
import * as wireCanvasName from "../src/shared/wire/canvas-name";
import * as wireMention from "../src/shared/wire/mention";
import * as wireNodeRef from "../src/shared/wire/node-ref";
import * as wirePad from "../src/shared/wire/pad";
import * as wireActor from "../src/shared/wire/resource-actor";
import * as wireSheet from "../src/shared/wire/sheet";
import * as wireUlid from "../src/shared/wire/ulid";

/** Each name is the same object on the desktop path as on the wire. */
const same = (desktop: Record<string, unknown>, wire: Record<string, unknown>, names: ReadonlyArray<string>): void => {
  for (const name of names) {
    expect(wire[name], `wire has ${name}`).toBeDefined();
    expect(desktop[name], name).toBe(wire[name]);
  }
};

describe("the artifact model on the wire is the desktop's own", () => {
  it("ids: NodeId, ItemId, OpId and TaskNumber are one definition", () => {
    same(physics, wireIds, ["NodeId"]);
    same(workIds, wireIds, ["ItemId", "OpId", "TaskNumber", "isItemId", "isOpId", "isTaskNumber", "ULID_SHAPE"]);
    same(ulid, wireUlid, ["ULID_PATTERN", "isUlid"]);
  });

  it("the writer: ResourceActor and ActorSeatId are one definition", () => {
    same(resourceCommand, wireActor, ["ResourceActor"]);
    same(actorSeat, wireActor, ["ActorSeatId"]);
  });

  it("labels: the label rule, its schemas and the colours are one definition", () => {
    same(labels, wireLabels, Object.keys(wireLabels));
    expect(Object.keys(labels).sort()).toEqual(Object.keys(wireLabels).sort());
  });

  it("sheets: the grid, its rows and columns and every sheet rule are one definition", () => {
    same(sheet, wireSheet, Object.keys(wireSheet));
    same(modelSheet, wireSheet, ["SheetGrid"]);
  });

  it("node refs: the junto:// form, its parser and the canvas-name check are one definition", () => {
    same(nodeRef, wireNodeRef, Object.keys(wireNodeRef));
    same(canvasName, wireCanvasName, Object.keys(wireCanvasName));
  });

  it("mentions: the refs, the link, its parsers and the kinds are one definition", () => {
    same(mention, wireMention, Object.keys(wireMention));
    expect(Object.keys(mention).sort()).toEqual(Object.keys(wireMention).sort());
  });

  it("pads: the pad, its patches, applyPatch and the digest are one definition", () => {
    same(pad, wirePad, Object.keys(wirePad));
    expect(Object.keys(pad).sort()).toEqual(Object.keys(wirePad).sort());
    same(padProject, wirePad, ["padToDigest"]);
  });

  it("artifacts: the schemas the phone decodes with and the rule it rules with are the desktop's", () => {
    // The companion decodes with these three; one schema object, so one decode.
    for (const name of ["Artifact", "ArtifactOp", "ArtifactEdit"] as const) {
      expect(artifact[name], name).toBe(wireArtifact[name]);
      expect(Schema.isSchema(wireArtifact[name]), name).toBe(true);
    }
    same(artifact, wireArtifact, ["ruleArtifactEdit", "patchKeys", "admitsAnchor", "ANCHOR_KINDS", "emptyBody", "artifactText"]);
    same(artifact, wireArtifact, Object.keys(wireArtifact));
    expect(Object.keys(artifact).sort()).toEqual(Object.keys(wireArtifact).sort());
  });
});
