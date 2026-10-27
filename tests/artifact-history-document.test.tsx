// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ArtifactVersionRecord } from "../src/shared/artifact";
import { ArtifactHistory } from "../src/renderer/components/artifacts/ArtifactHistory";

it("reads a past document version rendered, with nothing to type into", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const record = {
    artifactId: "01M5Y8Q54QZXTHSTHY0JE0G0KN",
    version: 1,
    author: { kind: "operator" },
    at: 0,
    body: { type: "document", markdown: "# Launch plan\n\nShip **the desktop app**." },
  } as unknown as ArtifactVersionRecord;
  await act(async () => root.render(<ArtifactHistory versions={[record]} head={2} now={0} onRestore={() => undefined} />));
  await act(async () => [...host.querySelectorAll<HTMLElement>('[role="list"] *')].find((row) => row.textContent?.startsWith("Version 1") && (row.tagName === "BUTTON" || row.getAttribute("role") === "button"))!.click());
  const content = host.querySelector<HTMLElement>(".cm-content")!;
  expect(content.getAttribute("contenteditable")).toBe("false");
  expect(content.textContent).not.toContain("**");
  expect(content.textContent).toContain("the desktop app");
  expect(host.querySelector(".artifact-history__text")).toBeNull();
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
