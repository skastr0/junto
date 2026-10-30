/**
 * The Cmd+T desk's view state (0.12): a stored row made safe, a desk that
 * reopens on what it can actually show, and the row it writes back. The text
 * of the writing is never here; these are the pointers and the places.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_CAPTURE_DESK,
  captureDeskOf,
  captureDeskRowOf,
  openRefOf,
  reopenedDesk,
} from "../src/renderer/components/capture/capture-desk-state";

const stored = {
  open_kind: "artifact",
  open_node_id: "artifacts-1",
  open_artifact_id: "artifact-7",
  query: "pricing",
  focused_artifact_id: "artifact-7",
  caret: 42,
  scroll_writing: 180,
  scroll_list: 24,
};

describe("the capture desk state", () => {
  it("reads a stored row into the desk, and writes the same row back", () => {
    const desk = captureDeskOf(stored);
    expect(desk).toEqual({
      open: { kind: "artifact", nodeId: "artifacts-1", artifactId: "artifact-7" },
      query: "pricing",
      focused: "artifact-7",
      caret: 42,
      scrollWriting: 180,
      scrollList: 24,
    });
    expect(captureDeskRowOf(desk)).toEqual(stored);
  });

  it("never trusts a row: unknown fields drop, half a pointer is no pointer, offsets clamp", () => {
    expect(captureDeskOf({ open_kind: "artifact", open_node_id: "artifacts-1" }).open).toEqual({ kind: "new" });
    expect(captureDeskOf({ open_kind: "elsewhere" }).open).toEqual({ kind: "new" });
    expect(captureDeskOf({ scroll_writing: -40, scroll_list: 3.9 }).scrollWriting).toBe(0);
    expect(captureDeskOf({ scroll_list: 3.9 }).scrollList).toBe(3);
    expect(captureDeskOf({ caret: "12" }).caret).toBeNull();
    expect(captureDeskOf(null)).toEqual(EMPTY_CAPTURE_DESK);
    expect(captureDeskOf("nonsense")).toEqual(EMPTY_CAPTURE_DESK);
    expect(captureDeskOf({ focused_artifact_id: "" }).focused).toBeNull();
  });

  it("reopens the saved artifact while the list still offers it", () => {
    const desk = captureDeskOf(stored);
    expect(reopenedDesk(desk, (id) => id === "artifact-7")).toEqual(desk);
  });

  it("reopens a new capture, same query and scrolls, when the artifact is gone", () => {
    const desk = captureDeskOf(stored);
    const reopened = reopenedDesk(desk, () => false);
    expect(reopened.open).toEqual({ kind: "new" });
    expect(reopened.focused).toBeNull();
    expect(reopened.query).toBe("pricing");
    expect(reopened.scrollWriting).toBe(180);
  });

  it("gives the move column the open ref, and undefined for a new capture", () => {
    expect(openRefOf(captureDeskOf(stored))).toEqual({ nodeId: "artifacts-1", artifactId: "artifact-7" });
    expect(openRefOf(EMPTY_CAPTURE_DESK)).toBeUndefined();
  });
});
