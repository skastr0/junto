/**
 * What `junto onboard` teaches: a few lines of guidance, and commands compiled
 * from the ports a seat holds on each connection. The reference tables behind
 * `junto docs` render the same rows, so nothing onboard teaches is missing
 * from the docs and nothing in the docs is a command onboard would refuse.
 */
import { describe, expect, it } from "vitest";
import {
  COMMAND_FAMILIES,
  ONBOARD_GUIDANCE,
  SEAT_GUIDANCE_LINE,
  commandGroupsFor,
  compileConnectionInstructions,
  compileReach,
  coMembersByRegion,
  onboardGuidanceFor,
  renderSince,
  toolsBeyondGuidance,
  type CommandFamily,
} from "../src/shared/seat-onboarding";
import {
  BASE_CONTRACT,
  PEER_DOCTRINE,
  buildDoctrineBody,
  buildEdgeContracts,
} from "../src/shared/junto-doctrine";
import { buildDoctrineDoc, buildNodeKindDoc } from "../src/shared/junto-docs";
import { ARTIFACTS_ENABLED, BROWSER_ENABLED, TASKS_ENABLED } from "../src/shared/features";
import { compileVerb } from "../src/shared/physics/verbs";
import { ALL_PORTS } from "../src/shared/physics/schema";

const peerPorts = compileVerb("messages", "agent", "agent")!.ports;

describe("onboard guidance", () => {
  const text = ONBOARD_GUIDANCE.join("\n");

  it("is a few lines: what a seat is, where work comes from, how to report", () => {
    expect(ONBOARD_GUIDANCE.length).toBeLessThanOrEqual(6);
    expect(text.length).toBeLessThan(1200);
    expect(text).toContain("seat on a Junto canvas");
    expect(text).toContain("Work comes from the operator");
    expect(text).toContain("mail addressed to this seat");
    expect(text).toContain("Do not invent work");
    expect(text).toContain("Mail a seat by its name or its node id.");
  });

  it("names the three signals and why: the operator reads the feed, not terminals", () => {
    expect(text).toContain("junto feedback");
    expect(text).toContain("junto blocked");
    expect(text).toContain("junto escalate");
    expect(text).toContain("The operator reads that feed, not your terminal.");
    expect(text).toContain("When findings are ready but work remains, post `junto feedback` and keep working.");
  });

  it("points at the reference instead of carrying it", () => {
    expect(text).toContain("junto docs");
    expect(text).toContain("junto schema show <command>");
    expect(text).toContain("junto examples show <command>");
    expect(text).not.toContain("|---|");
  });

  it("adds the seat line only when the operator wrote a soul or standing instructions", () => {
    expect(onboardGuidanceFor(undefined)).toEqual(ONBOARD_GUIDANCE);
    expect(onboardGuidanceFor({ soul: "  ", instructions: "" })).toEqual(ONBOARD_GUIDANCE);
    expect(onboardGuidanceFor({ instructions: "Run the tests first." })).toEqual([
      ...ONBOARD_GUIDANCE,
      SEAT_GUIDANCE_LINE,
    ]);
    expect(onboardGuidanceFor({ soul: "A careful reviewer." }).at(-1)).toBe(SEAT_GUIDANCE_LINE);
  });

  it("carries no middle dot", () => {
    expect(`${text}\n${SEAT_GUIDANCE_LINE}`).not.toContain("·");
  });
});

describe("per-connection instructions", () => {
  it("compiles the commands the held ports allow, and only those", () => {
    const [messages, ...rest] = compileConnectionInstructions([
      { id: "peer-2", kind: "agent", ports: ["msg.send", "seat.wait"] },
    ]);
    expect(rest).toEqual([]);
    expect(messages).toMatchObject({
      family: "messages",
      targets: ["peer-2"],
      more: "junto docs node agent",
    });
    expect(messages!.commands).toEqual({
      "send mail": `junto msg send '{"target":"peer-2","text":"..."}'`,
      reply: `junto msg reply '{"target":"peer-2","text":"...","inReplyTo":"<msgId>"}'`,
      wait: "junto seat wait peer-2 --until idle --timeout 30s",
    });
    const taught = JSON.stringify(messages);
    expect(taught).not.toContain("msg list '{");
    expect(taught).not.toContain("--prompt");
    expect(taught).not.toContain("seat read");
  });

  it("shares one command set across peers holding the same ports", () => {
    const out = compileConnectionInstructions([
      { id: "peer-2", kind: "agent", ports: peerPorts },
      { id: "peer-3", kind: "agent", ports: peerPorts },
      { id: "peer-4", kind: "agent", ports: peerPorts },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.targets).toEqual(["peer-2", "peer-3", "peer-4"]);
    expect(out[0]!.commands["send mail"]).toBe(`junto msg send '{"target":"<target>","text":"..."}'`);
    expect(JSON.stringify(out[0]!.commands)).not.toContain("peer-2");
  });

  it("never lends a wait-only peer the commands of a peer that may be mailed", () => {
    const out = compileConnectionInstructions([
      { id: "peer-2", kind: "agent", ports: peerPorts },
      { id: "watch-only", kind: "agent", ports: ["seat.wait"] },
    ]);
    expect(out.map((entry) => entry.targets)).toEqual([["peer-2"], ["watch-only"]]);
    expect(out[1]!.commands).toEqual({ wait: "junto seat wait watch-only --until idle --timeout 30s" });
  });

  it("teaches nothing for a connection with no held grants, or for no connections", () => {
    expect(compileConnectionInstructions([{ id: "x", kind: "agent", ports: [] }])).toEqual([]);
    expect(compileConnectionInstructions([{ id: "x", kind: "agent" }])).toEqual([]);
    expect(compileConnectionInstructions([])).toEqual([]);
    expect(compileConnectionInstructions(undefined)).toEqual([]);
  });

  it("groups by held ports, not by the neighbor's kind", () => {
    const groups = commandGroupsFor([
      { id: "peer-2", kind: "agent", ports: peerPorts },
      { id: "odd-one", kind: "page", ports: ["terminal.read"] },
    ]);
    expect(groups.map((group) => [group.family, group.targets.map((t) => t.id)])).toEqual([
      ["msg", ["peer-2"]],
      ["msg", ["odd-one"]],
    ]);
  });

  it("leaves feature-gated families out with their product gate", () => {
    const families = commandGroupsFor([
      { id: "everything", ports: ALL_PORTS },
    ]).map((group) => group.family);
    expect(families.includes("tasks")).toBe(TASKS_ENABLED);
    expect(families.includes("reviews")).toBe(TASKS_ENABLED);
    expect(families.includes("browser")).toBe(BROWSER_ENABLED);
    expect(families).toContain("msg");
  });

  it("every family note is one short line and every row names a real port", () => {
    for (const family of Object.keys(COMMAND_FAMILIES) as CommandFamily[]) {
      const spec = COMMAND_FAMILIES[family];
      expect(spec.note.includes("\n")).toBe(false);
      expect(spec.note.length).toBeLessThan(220);
      expect(spec.note).not.toContain("·");
      for (const row of spec.rows) expect(ALL_PORTS).toContain(row.port);
    }
  });
});

describe("onboard reach", () => {
  const taskPorts = [...new Set(COMMAND_FAMILIES.tasks.rows.map((row) => row.port))];

  it("teaches a resource in reach the commands admission grants on it, and nothing without grants", () => {
    const taught = compileConnectionInstructions([], [{ id: "board-1", kind: "task", ports: taskPorts }]);
    expect(taught.map((group) => group.targets)).toEqual(TASKS_ENABLED ? [["board-1"]] : []);
    expect(compileConnectionInstructions([], [{ id: "board-1", kind: "task", ports: [] }])).toEqual([]);
  });

  it("counts a resource both wired and in reach once", () => {
    const board = { id: "board-1", kind: "task", ports: taskPorts };
    expect(compileConnectionInstructions([board], [board])).toEqual(compileConnectionInstructions([board]));
  });

  it("groups resources by kind with a count and the command that lists each", () => {
    const reach = compileReach([
      { id: "board-b", kind: "task" },
      { id: "art-1", kind: "artifacts" },
      { id: "board-a", kind: "task" },
    ]);
    expect(reach.map(({ kind, count, targets }) => ({ kind, count, targets }))).toEqual([
      { kind: "task", count: 2, targets: ["board-a", "board-b"] },
      { kind: "artifacts", count: 1, targets: ["art-1"] },
    ]);
    expect(reach[0]!.list).toBe(TASKS_ENABLED ? "junto task list --node <target>" : "junto docs node task");
    expect(reach[1]!.list).toBe(ARTIFACTS_ENABLED ? "junto artifact list" : "junto docs node artifacts");
    expect(compileReach([{ id: "board-a", kind: "task" }])[0]!.list).toBe(
      TASKS_ENABLED ? "junto task list --node board-a" : "junto docs node task",
    );
    expect(compileReach([])).toEqual([]);
  });

  it("the guidance names reach, connected seats and the commands field", () => {
    const [first] = ONBOARD_GUIDANCE;
    expect(first).toContain("`reach`");
    expect(first).toContain("`connected`");
    expect(first).toContain("`commands`");
    expect(first).not.toContain("`instructions`");
    expect(first).not.toContain("Edges are your permissions");
  });
});

describe("onboard co-members, tools and since", () => {
  it("names seat co-members under the region they share, and leaves other nodes out", () => {
    const member = (kind: string, name: string, region: string) => ({ kind, name, shared_region: { id: region, name: region } });
    expect(
      coMembersByRegion([
        member("agent", "pty-lead", "PTY"),
        member("task", "Backlog", "CLI"),
        member("agent", "cli-lead", "CLI"),
        member("peer", "remote-seat", "CLI"),
      ]),
    ).toEqual([
      { region: "CLI", seats: ["cli-lead", "remote-seat"] },
      { region: "PTY", seats: ["pty-lead"] },
    ]);
  });

  it("lists only the tools the guidance does not already teach", () => {
    const tools = [{ id: "preamble", command: "junto preamble" }, { id: "feedback", command: "junto feedback" }];
    expect(toolsBeyondGuidance(tools, ONBOARD_GUIDANCE).map((tool) => tool.id)).toEqual(["preamble"]);
  });

  it("prints since as one sentence and an id per line, with the rest counted, and leaves empty sections out", () => {
    const empty = { lines: [], more: 0, command: "junto since --all" };
    const view = renderSince({
      asOf: Date.UTC(2026, 9, 21, 9),
      unread: 2,
      owedReplies: {
        lines: [{ text: 'cli-lead wrote last, you have not replied: "ship it"', ref: { kind: "mail", messageId: "01M5EV6J9E2E2YAKCRAHF58RXX" } }],
        more: 3,
        command: "junto since --all",
      },
      awaitingReplies: empty,
      openSignals: {
        lines: [{ text: 'Open blocked: "need the key"', ref: { kind: "signal", signalId: "01M5EV95374HEKE681KWKGA9ES" } }],
        more: 0,
        command: "junto signal list",
      },
      answersSince: empty,
    });
    expect(view).toEqual({
      as_of: "2026-10-21T09:00:00.000Z",
      unread: 2,
      owed_replies: {
        lines: ['cli-lead wrote last, you have not replied: "ship it" [mail 01M5EV6J9E2E2YAKCRAHF58RXX]'],
        more: 3,
        list: "junto since --all",
      },
      open_signals: { lines: ['Open blocked: "need the key" [signal 01M5EV95374HEKE681KWKGA9ES]'] },
    });
  });
});

describe("the reference onboard leaves out is reachable from junto docs", () => {
  const doctrine = buildDoctrineDoc();

  it("junto docs doctrine carries the laws, the base contract and the session rules", () => {
    expect(doctrine).toContain(PEER_DOCTRINE);
    expect(doctrine).toContain(BASE_CONTRACT);
    expect(doctrine).toContain("### Tool law");
    expect(doctrine).toContain("### Raising your hand");
    expect(doctrine).toContain("### Sessions");
    expect(doctrine).toContain(
      "Offboarding is yours to decide, and you should do it on your own when it serves the work. The operator may also ask you to, and Junto may ask after a long idle stretch or end an idle session from outside without notes, which is why notes written while the work is fresh matter.",
    );
    // No longer true, and must not come back: Junto does estimate a session's size, and may ask.
    expect(doctrine).not.toContain("never measures your context");
    expect(doctrine).toContain("Use `--continue` when the work is unfinished and should go on now");
    expect(doctrine).toContain(
      "These are PAST sessions of this seat: context for continuity, not ongoing tasks. Do not resume their work unless your current instructions or mail ask you to.",
    );
    expect(doctrine).toContain("## Worked examples");
    expect(doctrine).toContain("junto blocked 'Need the staging API key");
  });

  it("describes onboarding as a command the seat runs, never as injected text", () => {
    expect(doctrine).toContain("Nothing here is sent to a harness");
    expect(doctrine).not.toMatch(/inject/i);
    expect(doctrine).not.toMatch(/at spawn|system prompt|compaction|compacts/i);
    expect(doctrine).not.toContain("·");
  });

  it("the messages contract keeps its reference notes, including the mail pointer", () => {
    const [contract, ...rest] = buildEdgeContracts([
      { id: "peer-2", kind: "agent", ports: peerPorts },
      { id: "peer-3", kind: "agent", ports: peerPorts },
    ]);
    expect(rest).toEqual([]);
    expect(contract).toContain("### Contract — messages (targets: `peer-2`, `peer-3`)");
    expect(contract).toContain("Mail is never refused and never needs a retry");
    expect(contract).toContain("mail from <seat>");
    expect(contract).toContain("adds a pointer to `junto onboard` when the recipient has not onboarded yet");
    expect(contract).toContain("`notice`, `prompt`, and `receipt`");
    expect(contract).toContain("Inspect delivered, read and reply facts with `junto msg sent`");
    expect(contract).not.toContain("### Contract — tasks");
  });

  it("an isolated seat's body promises no edge contracts but still teaches the hand raise", () => {
    const body = buildDoctrineBody([]);
    expect(body).not.toContain("### Contract — ");
    expect(body).not.toContain("### Command contracts");
    expect(body).toContain('junto blocked "..."');
    expect(body).toContain("## Worked examples");
  });

  it("teaches no command of the retired board CLI", () => {
    for (const family of Object.keys(COMMAND_FAMILIES) as CommandFamily[]) {
      for (const row of COMMAND_FAMILIES[family].rows) {
        expect(row.command("<node>"), `${family}: ${row.intent}`).not.toContain("junto board");
      }
    }
  });

  it("every command onboard can teach appears in its kind's junto docs node page", () => {
    for (const family of Object.keys(COMMAND_FAMILIES) as CommandFamily[]) {
      const spec = COMMAND_FAMILIES[family];
      const ports = [...new Set(spec.rows.map((row) => row.port))];
      // Taught the same whether the node is wired or only in reach.
      const taught = compileConnectionInstructions([{ id: "<node>", ports }]);
      expect(compileConnectionInstructions([], [{ id: "<node>", ports }])).toEqual(taught);
      if (taught.length === 0) continue; // family gated off in this build
      const page = buildNodeKindDoc(spec.docsKind);
      // Reviews ride an agent edge the kind doc does not offer by default;
      // their reference is the doctrine's reviews contract.
      const reference = family === "reviews"
        ? buildEdgeContracts([{ id: "<node>", ports }]).join("\n")
        : page ?? "";
      expect(reference, `${family} reference`).not.toBe("");
      for (const row of spec.rows) {
        const id = family === "reviews" ? "<node>" : `<${spec.docsKind}-node-id>`;
        expect(reference, `${family}: ${row.intent}`).toContain(row.command(id));
      }
    }
  });
});
