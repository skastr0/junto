/**
 * Wire-fidelity sanity check for e2e/fakes/bin/herdr: pipes the fake's real
 * process output through the REAL production parsers — no reimplementation,
 * no mocks. Two paths:
 *
 *  1. CLI envelope path: `herdr workspace list` / `pane list` output decoded
 *     via parseCliEnvelope + parseWorkspaceList/parsePaneList (parse.ts).
 *  2. Socket path: a real `herdr server` daemon, a real HerdrMirror bound to
 *     a real LocalMirrorTransport (mirror.ts / mirror-transport.ts) —
 *     session.snapshot bootstrap plus one pushed lifecycle event, decoded via
 *     the actual mirror + event-normalize.ts (not a copy of its logic).
 *
 * Everything is sandboxed under a throwaway HOME (never touches the
 * operator's real ~/.config/herdr) and every spawned process is torn down in
 * afterEach.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeHerdrEvent } from "../src/main/vellum/herdr/event-normalize";
import { HerdrMirror } from "../src/main/vellum/herdr/mirror";
import { LocalMirrorTransport } from "../src/main/vellum/herdr/mirror-transport";
import {
  parseCliEnvelope,
  parsePaneList,
  parseWorkspaceList,
} from "../src/main/vellum/herdr/parse";
import { oneWorkspaceWorld, writeScenario, type FakeHerdrScenario } from "../e2e/fakes/scenario";

const execFileAsync = promisify(execFile);

const FAKE_HERDR = fileURLToPath(new URL("../e2e/fakes/bin/herdr", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
};

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly scenarioPath: string;
  readonly env: NodeJS.ProcessEnv;
}

const makeSandbox = async (): Promise<Sandbox> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-fake-herdr-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }).catch(() => undefined));
  const home = join(root, "home");
  const scenarioPath = join(root, "scenario.json");
  return {
    root,
    home,
    scenarioPath,
    env: { ...process.env, HOME: home, FAKE_HERDR_SCENARIO: scenarioPath },
  };
};

const setup = async (
  scenario: FakeHerdrScenario,
): Promise<{ readonly home: string; readonly env: NodeJS.ProcessEnv }> => {
  const sandbox = await makeSandbox();
  await writeScenario(sandbox.scenarioPath, scenario);
  return { home: sandbox.home, env: sandbox.env };
};

describe("fake herdr — CLI envelope decodes via the real parse.ts", () => {
  it("workspace list / pane list round-trip through parseCliEnvelope + parseWorkspaceList/parsePaneList", async () => {
    const { env } = await setup({ world: oneWorkspaceWorld() });

    const wsResult = await execFileAsync(FAKE_HERDR, ["workspace", "list"], { env });
    const wsEnvelope = parseCliEnvelope(wsResult.stdout);
    expect(wsEnvelope.ok).toBe(true);
    if (!wsEnvelope.ok) throw new Error("unreachable");
    const workspaces = parseWorkspaceList(wsEnvelope.result);
    expect(workspaces).toEqual([
      { workspaceId: "w1", label: "demo", tabCount: 1, paneCount: 1, agentStatus: "idle" },
    ]);

    const paneResult = await execFileAsync(FAKE_HERDR, ["pane", "list"], { env });
    const paneEnvelope = parseCliEnvelope(paneResult.stdout);
    expect(paneEnvelope.ok).toBe(true);
    if (!paneEnvelope.ok) throw new Error("unreachable");
    const panes = parsePaneList(paneEnvelope.result);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.paneId).toBe("w1:p1");
    expect(panes[0]?.terminalId).toBe("term_1");
    expect(panes[0]?.agent).toBe("codex");
  });

  it("workspace create mutates state visible to a subsequent process (pane get)", async () => {
    const { env } = await setup({ world: { workspaces: [], tabs: [], panes: [], agents: [], layouts: [] } });

    const created = await execFileAsync(
      FAKE_HERDR,
      ["workspace", "create", "--cwd", "/tmp/proj", "--label", "created-ws"],
      { env },
    );
    const createdEnvelope = parseCliEnvelope(created.stdout);
    expect(createdEnvelope.ok).toBe(true);
    if (!createdEnvelope.ok) throw new Error("unreachable");
    const ids = createdEnvelope.result as { readonly root_pane: { readonly pane_id: string } };

    const got = await execFileAsync(FAKE_HERDR, ["pane", "get", ids.root_pane.pane_id], { env });
    const gotEnvelope = parseCliEnvelope(got.stdout);
    expect(gotEnvelope.ok).toBe(true);
    if (!gotEnvelope.ok) throw new Error("unreachable");
    expect((gotEnvelope.result as { readonly pane: { readonly cwd: string } }).pane.cwd).toBe("/tmp/proj");
  });
});

describe("fake herdr server — real socket protocol decodes via mirror.ts + event-normalize.ts", () => {
  it("bootstraps a real HerdrMirror from the fake's session.snapshot, then applies a pushed lifecycle event", async () => {
    const world = oneWorkspaceWorld();
    const sandbox = await makeSandbox();
    const trigger = join(sandbox.root, "go-rename");
    await writeScenario(sandbox.scenarioPath, {
      world,
      events: [
        {
          event: "workspace_renamed",
          data: { type: "workspace_renamed", workspace_id: "w1", label: "renamed-by-fake" },
          waitFor: trigger,
        },
      ],
    });
    const env = sandbox.env;

    const server = spawn(FAKE_HERDR, ["server"], { env, stdio: "ignore" });
    cleanup.push(() => {
      server.kill("SIGTERM");
    });

    const socketPath = join(sandbox.home, ".config", "herdr", "herdr.sock");
    await waitFor(() => existsSync(socketPath));

    // Primary mirror under test — production code, unmodified.
    const transport = new LocalMirrorTransport(socketPath);
    const mirror = new HerdrMirror("fake-host", transport, {
      backoffMs: [20],
      resubscribeDebounceMs: 20,
      changeCoalesceMs: 0,
    });
    cleanup.push(() => mirror.stop());
    mirror.start();
    await waitFor(() => mirror.isFresh());

    // Snapshot decode fidelity (mirror.ts's applySnapshot over the fake's
    // real session.snapshot response).
    expect(mirror.listWorkspaces()?.map((w) => w.workspace_id)).toEqual(["w1"]);
    expect(mirror.listPanes()?.map((p) => p.pane_id)).toEqual(["w1:p1"]);
    expect(mirror.paneRecord("w1:p1")?.terminal_id).toBe("term_1");
    expect(mirror.listAgents()?.[0]?.agent).toBe("codex");
    expect(mirror.focused().paneId).toBe("w1:p1");

    // Secondary raw connection: captures the exact wire object the fake
    // pushes, independently proving event-normalize.ts decodes it correctly
    // (not inferred from the mirror's derived state).
    const rawEvents: Array<Record<string, unknown>> = [];
    const rawTransport = new LocalMirrorTransport(socketPath);
    const closeRaw = await rawTransport.openEvents(
      [{ type: "workspace.renamed" }],
      (evt) => rawEvents.push(evt),
      () => undefined,
    );
    cleanup.push(() => closeRaw());

    // Fire the scripted event (server-side pump was waiting on this file).
    await mkdir(sandbox.root, { recursive: true });
    await writeFile(trigger, "", "utf8");

    await waitFor(() => mirror.listWorkspaces()?.[0]?.label === "renamed-by-fake");
    await waitFor(() => rawEvents.length > 0);

    const raw = rawEvents[0]!;
    expect(raw.event).toBe("workspace_renamed");
    const normalized = normalizeHerdrEvent(raw);
    expect(normalized?.kind).toBe("workspace.renamed");
    expect(normalized?.body.workspace_id).toBe("w1");
    expect(normalized?.body.label).toBe("renamed-by-fake");
  }, 15_000);
});
