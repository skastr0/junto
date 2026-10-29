// @vitest-environment jsdom
/**
 * A signal's task and artifact chips open the thing itself, and an artifact
 * is found by its id wherever it is now (0.11.1, 10): one moved since the
 * signal was raised still opens, titled by its own title, and never by the
 * node it left.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSignalResourceAttachment } from "../src/shared/agent-signals";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import type { ItemId } from "../src/shared/work-ids";
import { artifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { artifacts, canvasOf, seat } from "./support/model-nodes";

const opened = vi.hoisted(() => ({ calls: [] as Array<{ nodeId: string; itemId: string | undefined }> }));
vi.mock("../src/renderer/lib/work-detail-open", () => ({
  openWorkDetail: (nodeId: string, options?: { readonly itemId?: string }) =>
    opened.calls.push({ nodeId, itemId: options?.itemId }),
}));

const canvas = canvasOf([artifacts("specs", { label: "Specs" }), artifacts("release", { label: "Release" }), seat("lead")]);
vi.mock("../src/renderer/lib/use-model", async (load) => ({
  ...(await load<typeof import("../src/renderer/lib/use-model")>()),
  useCanvas: () => canvas,
}));

const { SignalResourceChips } = await import("../src/renderer/components/signals/SignalResourceChips");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "factory";
const ARTIFACT = "01M5ZC0000000000000000000B" as ItemId;
const TASK = "01M5ZC0000000000000000000C" as ItemId;
const original = artifactsSource();
let root: Root;
let host: HTMLDivElement;

const head = (nodeId: string, title: string): ArtifactHead =>
  ({ artifact: { artifactId: ARTIFACT, nodeId, title, type: "document", archived: false } }) as unknown as ArtifactHead;

/** The store as it stands after the move: nothing on Specs, the document on Release. */
const movedSource = (): ArtifactsSource =>
  ({
    ...original,
    list: async (_canvas: string, nodeId: string) => (nodeId === "release" ? [head("release", "Brief")] : []),
    moves: async () => [{ from: "specs", to: "release", by: { kind: "operator" }, at: 1 }],
    onChanged: () => () => undefined,
  }) as unknown as ArtifactsSource;

const artifactAttachment = (over: Partial<Extract<AgentSignalResourceAttachment, { readonly kind: "artifact" }>> = {}): AgentSignalResourceAttachment => ({
  kind: "artifact",
  nodeId: "specs",
  artifactId: ARTIFACT,
  ...over,
});

beforeEach(() => {
  opened.calls.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setArtifactsSource(original);
});

const render = async (attachments: ReadonlyArray<AgentSignalResourceAttachment>) => {
  await act(async () => root.render(<SignalResourceChips canvasName={CANVAS} attachments={attachments} />));
  // The where-it-is read lands after the first paint.
  await act(async () => undefined);
};

const chip = (): HTMLElement => host.querySelector<HTMLElement>("[data-testid='signal-resource-chips'] .resource-chip")!;

it("opens an artifact where it is now, titled by itself, not by the node it left", async () => {
  setArtifactsSource(movedSource());
  await render([artifactAttachment()]);
  expect(chip().querySelector(".resource-chip__label")?.textContent).toBe("Brief");
  await act(async () => chip().click());
  expect(opened.calls).toEqual([{ nodeId: "release", itemId: ARTIFACT }]);
});

it("keeps a caption when the agent gave one", async () => {
  setArtifactsSource(movedSource());
  await render([artifactAttachment({ caption: "the brief" })]);
  expect(chip().querySelector(".resource-chip__label")?.textContent).toBe("the brief");
});

it("opens a task on its board, the task itself", async () => {
  await render([{ kind: "task", nodeId: "lead", taskId: TASK }]);
  await act(async () => chip().click());
  expect(opened.calls).toEqual([{ nodeId: "lead", itemId: TASK }]);
});

it("draws an artifact its node no longer holds, and nowhere else, unavailable", async () => {
  setArtifactsSource({ ...original, list: async () => [], moves: async () => [], onChanged: () => () => undefined } as unknown as ArtifactsSource);
  await render([artifactAttachment({ nodeId: "gone" })]);
  expect(chip().getAttribute("data-missing")).toBe("true");
  await act(async () => chip().click());
  expect(opened.calls).toEqual([]);
});
