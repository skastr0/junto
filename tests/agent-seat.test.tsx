/**
 * AgentSeatView: the line beneath the name says the loudest thing, in order:
 * the seat's own signal, a spawn failure, the AI's reading (marked as AI),
 * then the control state.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import { AgentSeatView } from "../src/renderer/components/nodes/AgentSeat";
import { terminalActivity } from "../src/renderer/lib/activity";

const signal: AgentSignal = {
  signalId: "s1",
  canvasName: "c",
  nodeId: "n",
  kind: "blocked",
  text: "needs the prod DB password",
  createdAt: 0,
  state: "open",
};

const line = (html: string): string => {
  const m = /data-testid="agent-seat-line">(.*?)<\/div>/.exec(html);
  return (m?.[1] ?? "").replace(/<[^>]+>/g, "");
};

const seat = (props: Partial<Parameters<typeof AgentSeatView>[0]>) =>
  renderToStaticMarkup(
    <AgentSeatView
      identity="n"
      activity={terminalActivity({ seatState: "working" })}
      title="planner"
      health={{}}
      signal={{ openCount: 0 }}
      {...props}
    />,
  );

describe("AgentSeatView line", () => {
  it("a declared signal wins over everything", () => {
    const html = seat({
      signal: { worst: signal, openCount: 1 },
      context: "claude is not installed",
      health: { health: "good", line: "going well" },
    });
    expect(line(html)).toBe("blocked needs the prod DB password");
  });

  it("a spawn failure comes next", () => {
    expect(line(seat({ context: "claude is not installed", health: { line: "going well" } }))).toBe(
      "claude is not installed",
    );
  });

  it("the AI reading is marked as AI, never as the agent's claim", () => {
    expect(line(seat({ health: { health: "good", line: "going well" } }))).toBe("AIgoing well");
  });

  it("proven attention outranks the AI reading; the reading outranks done", () => {
    const good = { health: "good" as const, line: "going well" };
    expect(line(seat({ activity: terminalActivity({ seatState: "attention" }), health: good }))).toBe(
      "wants your input",
    );
    expect(
      line(
        seat({
          activity: terminalActivity({ seatState: "idle", needsLook: true }),
          health: { health: "waiting", line: "wants your input" },
        }),
      ),
    ).toBe("AIwants your input");
  });

  it("a steady reading leaves the line to the control state, as the minimap does", () => {
    expect(line(seat({ health: { health: "steady", line: "steady" } }))).toBe("working");
  });

  it("otherwise the control state in words", () => {
    expect(line(seat({ activity: terminalActivity({ seatState: "attention" }) }))).toBe("wants your input");
    expect(line(seat({ activity: terminalActivity({ seatState: "idle", needsLook: true }) }))).toBe(
      "done, not read yet",
    );
  });

  it("the ring holds a round portrait", () => {
    const html = seat({});
    expect(html).toContain('data-mark-size="seat"');
    expect(html).toContain('class="junto-mark__seat"');
  });
});
