// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintItemId, mintOpId } from "../src/shared/resource-command";
import type { ArtifactPendingWrite } from "../src/renderer/lib/artifacts-source";
import { ArtifactPendingWrites } from "../src/renderer/components/artifacts/ArtifactPendingWrites";
import { opLabel, pendingWriteLine } from "../src/renderer/components/artifacts/artifacts-pane-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const write = (overlay?: ArtifactPendingWrite["overlay"]): ArtifactPendingWrite => ({
  opId: mintOpId(),
  artifactId: mintItemId(),
  op: { op: "retitle", title: "Plan" },
  ...(overlay === undefined ? {} : { overlay }),
});

describe("pending artifact writes", () => {
  it("reads pending quiet, and at risk with its reason", () => {
    expect(pendingWriteLine(write())).toEqual({ tone: "pending", text: "Waiting for the editing machine" });
    expect(pendingWriteLine(write({ status: "pending" })).tone).toBe("pending");
    expect(pendingWriteLine(write({ status: "at_risk", refusal: { reason: "stale", message: "the head moved to 4" } }))).toEqual({
      tone: "risk",
      text: "Would be refused now: the head moved to 4",
    });
    const root = mintOpId();
    expect(pendingWriteLine(write({ status: "at_risk", waiting: "base_not_pulled", root })).text).toContain("latest version");
  });

  it("names every op", () => {
    expect(opLabel({ op: "retitle", title: "Plan" })).toBe("Rename to Plan");
    expect(opLabel({ op: "archive" })).toBe("Archive");
    expect(opLabel({ op: "tasks", taskIds: [] })).toBe("Change its tasks");
  });

  it("draws each write with its tone, and nothing when none wait", () => {
    act(() => root.render(<ArtifactPendingWrites writes={[]} />));
    expect(host.querySelector("ul")).toBeNull();
    act(() =>
      root.render(
        <ArtifactPendingWrites writes={[write(), write({ status: "at_risk", refusal: { reason: "stale", message: "moved" } })]} />,
      ),
    );
    const rows = [...host.querySelectorAll("li")];
    expect(rows.map((row) => row.dataset.tone)).toEqual(["pending", "risk"]);
    expect(rows[1]?.textContent).toContain("Would be refused now: moved");
  });
});
