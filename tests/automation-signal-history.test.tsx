// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS, type Automation, type AutomationDefinition } from "@shared/automation";
import { asNodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import type { AgentSignal } from "@shared/wire/agent-signals";
import { AutomationsPane } from "../src/renderer/components/automations/AutomationsPane";
import { makeLocalAutomationsSource, setAutomationsSource } from "../src/renderer/lib/automations-source";
import { agentSignals$, replaceAgentSignals } from "../src/renderer/lib/agent-signals-state";
import { setNodeViewStore } from "../src/renderer/lib/node-view-state";
import { state$ } from "../src/renderer/lib/state";
import { makeMemoryNodeViewStore } from "../src/renderer/lib/view-state-stand-in";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no scrolling; the history brings a firing into view when a surface names one.
Element.prototype.scrollIntoView = function scrollIntoView(): void {};

const canvas = "automations-signal-history";
const node = asNodeId("automations-1");
const automationId = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");
const signalId = "01MSIGNAL00000000000000001";

let host: HTMLDivElement;
let root: Root;
let source: ReturnType<typeof makeLocalAutomationsSource>;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
};

const render = async (): Promise<void> => {
  await act(async () => root.render(<AutomationsPane canvasName={canvas} nodeId={node} author={{ kind: "operator" }} onClose={() => undefined} />));
  await flush();
};

const row = async (): Promise<void> => {
  const found = [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim().startsWith("Nightly check"));
  if (!found) throw new Error("no row for Nightly check");
  await act(async () => found.click());
  await flush();
};

const signal = (over: Partial<AgentSignal>): AgentSignal => ({
  signalId,
  canvasName: canvas,
  nodeId: "automations-1",
  source: { kind: "automation", automationId, nodeId: "automations-1", firingId: "01JFFFFFFFFFFFFFFFFFFFFFF1" },
  kind: "work",
  text: "Write 500 words",
  createdAt: 1_700_000_000_000,
  state: "open",
  ...over,
});

const definition: AutomationDefinition = {
  name: "Nightly check",
  trigger: { kind: "schedule", cron: "0 3 * * *", timezone: "UTC" },
  then: [{ kind: "signal", signal: "escalate", title: "Write 500 words" }],
  limits: DEFAULT_AUTOMATION_LIMITS,
};

const firing = {
  firingId: ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF1"),
  automationId,
  at: 1_700_000_000_000,
  cause: { kind: "run" as const },
  outcome: { kind: "fired" as const, actions: [{ index: 0 as const, ruling: "raised" as const, signalId }] },
};

beforeEach(async () => {
  setNodeViewStore(makeMemoryNodeViewStore());
  state$.canvasName.set(canvas);
  source = makeLocalAutomationsSource();
  setAutomationsSource(source);
  agentSignals$.set({});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await source.apply(canvas, node, automationId, { kind: "create", automationId, enabled: true, definition });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("opening the pane on one firing", () => {
  it("opens the automation the feed names, and marks the firing", async () => {
    act(() => replaceAgentSignals(canvas, [signal({})]));
    source.record(canvas, firing);
    await act(async () =>
      root.render(
        <AutomationsPane
          canvasName={canvas}
          nodeId={node}
          author={{ kind: "operator" }}
          initialAutomationId={automationId}
          initialFiringId={firing.firingId}
          openKey={1}
          onClose={() => undefined}
        />,
      ),
    );
    await flush();
    expect(document.body.textContent).toContain("Nightly check");
    const marked = document.body.querySelector(`[data-firing="${firing.firingId}"][data-focused]`);
    expect(marked).not.toBeNull();
    expect(marked?.textContent).toContain('raised "Write 500 words"');
  });
});

describe("a signal step in the automation's history", () => {
  it("says what it raised, and follows the signal as it is answered", async () => {
    act(() => replaceAgentSignals(canvas, [signal({})]));
    source.record(canvas, firing);
    await render();
    await row();
    expect(document.body.textContent).toContain('Step 1 raised "Write 500 words", still open');

    // The answer arrives an hour later; the history reads the signal's own row.
    await act(async () => {
      replaceAgentSignals(canvas, [
        signal({
          state: "answered",
          closedAt: 1_700_000_060_000,
          response: {
            text: "Morning pages is written, 512 words.",
            at: 1_700_000_060_000,
            artifact: { nodeId: "artifacts-1", artifactId: "01MARTIFACT000000000000001", title: "Morning pages", words: 512 },
          },
        }),
      ]);
    });
    await flush();
    expect(document.body.textContent).toContain('Step 1 raised "Write 500 words", answered');
    // The document handed in is the answer: a chip that opens its artifact.
    const chip = [...document.body.querySelectorAll(".automation-history__step button")].find((button) => button.textContent?.includes("Morning pages"));
    expect(chip).not.toBeUndefined();
  });

  it("shows an answer in words, cut to two lines with the rest a press away", async () => {
    const long = `Ship it after the smoke test. ${"Then tag it and post the notes. ".repeat(8)}`.trim();
    act(() => replaceAgentSignals(canvas, [signal({ state: "answered", response: { text: long, at: 1_700_000_060_000 } })]));
    source.record(canvas, firing);
    await render();
    await row();
    const words = document.body.querySelector<HTMLElement>(".automation-history__answer")!;
    expect(words.textContent).toBe(long);
    expect(words.hasAttribute("data-whole")).toBe(false);
    const more = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Show all")!;
    expect(more.getAttribute("aria-controls")).toBe(words.id);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => more.click());
    expect(words.hasAttribute("data-whole")).toBe(true);
    expect(more.textContent).toBe("Show less");
  });

  it("shows a secret only as given, never by its name or value", async () => {
    const secret = { item: "item-1", name: "DEPLOY_TOKEN", regionId: "region-1", machine: "mini", setAt: 1_700_000_060_000 };
    act(() => replaceAgentSignals(canvas, [signal({ state: "answered", response: { text: "", at: 1_700_000_060_000, secret } })]));
    source.record(canvas, firing);
    await render();
    await row();
    expect(document.body.textContent).toContain(", secret given");
    expect(document.body.textContent).not.toContain("DEPLOY_TOKEN");
  });
});

describe("a step held while its machine was not linked (0.12 S3)", () => {
  it("names the machine the firing ran on, the step that waits, and why a step did not run", async () => {
    // This machine knows its own name, and calls another machine by the label the operator reads.
    state$.settings.machine.name.set("macbook");
    state$.machines.set([{ id: "mini", label: "Mac mini" } as never]);
    source.record(canvas, {
      firingId: ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF9"),
      automationId,
      at: 1_700_000_000_000,
      cause: { kind: "run" },
      outcome: {
        kind: "fired",
        actions: [
          { index: 0, ruling: "refused", reason: "not_available" },
          { index: 1, ruling: "queued", waitingOn: { machine: "mini", since: 1_700_000_060_000 } },
        ],
      },
      machine: "mini",
    });
    await render();
    await row();
    expect(document.body.textContent).toContain("Run by hand, fired on Mac mini, 0 of 2 steps applied, 1 queued, 1 refused");
    expect(document.body.textContent).toContain("Step 1 not run: Raise a signal is not available on Mac mini");
    expect(document.body.textContent).toContain("Step 2 waiting for Mac mini since");
  });
});
