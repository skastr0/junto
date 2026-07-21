/**
 * Typed scenario shape + helpers for e2e/fakes/bin/herdr.
 *
 * A scenario is a JSON file pointed at by FAKE_HERDR_SCENARIO: the initial
 * world (workspaces/tabs/panes/agents/layouts, snake_case fields — verified
 * against a live `herdr api snapshot` 0.7.3 / protocol 16, see
 * tests/herdr-mirror.test.ts's fixture) plus a scripted timeline of terminal
 * frames and lifecycle events.
 *
 * Timeline steps may carry `waitFor: <path>` — the fake polls for that file's
 * existence before emitting, so a test can drive timing explicitly
 * (`touchTrigger`) instead of racing wall-clock delays.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FakeHerdrWorkspace {
  readonly workspace_id: string;
  readonly label?: string;
  readonly tab_count?: number;
  readonly pane_count?: number;
  readonly agent_status?: string;
  readonly focused?: boolean;
  readonly number?: number;
}

export interface FakeHerdrTab {
  readonly tab_id: string;
  readonly workspace_id: string;
  readonly label?: string;
  readonly pane_count?: number;
  readonly agent_status?: string;
  readonly focused?: boolean;
  readonly number?: number;
}

export interface FakeHerdrPane {
  readonly pane_id: string;
  readonly workspace_id?: string;
  readonly tab_id?: string;
  readonly terminal_id?: string;
  readonly cwd?: string;
  readonly foreground_cwd?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly label?: string;
  readonly focused?: boolean;
  readonly revision?: number;
}

export interface FakeHerdrLayout {
  readonly workspace_id: string;
  readonly tab_id: string;
  readonly panes?: ReadonlyArray<unknown>;
  readonly splits?: ReadonlyArray<unknown>;
  readonly zoomed?: boolean;
}

export interface FakeHerdrWorld {
  readonly workspaces: ReadonlyArray<FakeHerdrWorkspace>;
  readonly tabs: ReadonlyArray<FakeHerdrTab>;
  readonly panes: ReadonlyArray<FakeHerdrPane>;
  readonly agents: ReadonlyArray<FakeHerdrPane>;
  readonly layouts: ReadonlyArray<FakeHerdrLayout>;
  readonly focused_workspace_id?: string;
  readonly focused_tab_id?: string;
  readonly focused_pane_id?: string;
  readonly protocol?: number;
  readonly version?: string;
}

export interface FakeHerdrFrameStep {
  /** Base64 ANSI payload — use this or `text` (plain text, auto-base64'd). */
  readonly bytes?: string;
  readonly text?: string;
  readonly full?: boolean;
  readonly encoding?: string;
  readonly width?: number;
  readonly height?: number;
  /** Poll for this file's existence before emitting this step. */
  readonly waitFor?: string;
  /** Sleep this long before emitting this step (after waitFor, if both set). */
  readonly delayMs?: number;
  /** Emit `terminal.closed` and exit instead of a frame. */
  readonly closed?: boolean;
  readonly reason?: string;
}

export interface FakeHerdrEventStep {
  /** Wire shape: `{ event, data }` — lifecycle snake_case or dotted subscription kind. */
  readonly event: string;
  readonly data: Record<string, unknown>;
  readonly waitFor?: string;
  readonly delayMs?: number;
}

export interface FakeHerdrProcessFixture {
  /** `pane read --lines N --format text` result. */
  readonly readText?: string;
  /** `pane process-info` foreground process rows. */
  readonly foreground?: ReadonlyArray<{ readonly name?: string; readonly cmdline?: string; readonly pid?: number }>;
}

export interface FakeHerdrScenario {
  readonly world?: Partial<FakeHerdrWorld>;
  /** terminalId -> scripted frame timeline for `terminal session control|observe`. */
  readonly frames?: Readonly<Record<string, ReadonlyArray<FakeHerdrFrameStep>>>;
  /** Global lifecycle/subscription event timeline pushed over `events.subscribe`. */
  readonly events?: ReadonlyArray<FakeHerdrEventStep>;
  readonly processes?: Readonly<Record<string, FakeHerdrProcessFixture>>;
}

/** Write a scenario file for FAKE_HERDR_SCENARIO to point at. */
export const writeScenario = async (path: string, scenario: FakeHerdrScenario): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(scenario), "utf8");
};

/** Signal a `waitFor` trigger step — creates the file the fake is polling for. */
export const touchTrigger = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
};

/** The exact fixture shape tests/herdr-mirror.test.ts snapshots against (herdr
 * 0.7.3, protocol 16) — a ready-made single-workspace/tab/pane/agent world. */
export const oneWorkspaceWorld = (): FakeHerdrWorld => ({
  workspaces: [
    { workspace_id: "w1", label: "demo", tab_count: 1, pane_count: 1, agent_status: "idle", focused: true, number: 1 },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "1", pane_count: 1, agent_status: "idle", focused: true, number: 1 },
  ],
  panes: [
    {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      terminal_id: "term_1",
      cwd: "/proj",
      foreground_cwd: "/proj",
      agent: "codex",
      agent_status: "idle",
      focused: false,
      revision: 0,
    },
  ],
  agents: [
    {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      terminal_id: "term_1",
      cwd: "/proj",
      agent: "codex",
      agent_status: "idle",
      focused: false,
    },
  ],
  layouts: [{ workspace_id: "w1", tab_id: "w1:t1", panes: [], splits: [], zoomed: false }],
  focused_workspace_id: "w1",
  focused_tab_id: "w1:t1",
  focused_pane_id: "w1:p1",
  protocol: 16,
  version: "0.7.3",
});
