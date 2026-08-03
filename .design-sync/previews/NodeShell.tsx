import { CanvasStage, NodeShell } from "@skastr0/vellum";

// NodeShell is the composition shell every canvas node renders through — it
// owns border/background chrome, the resize handle, the hover toolbar, the
// flag rail, and connection handles. It takes children as the node body, so
// this preview stages a minimal demo node type that hands it realistic body
// content the way TextNode/FileNode/LinkNode/GroupNode do internally.

type DemoNodeData = {
  readonly node: {
    readonly id: string;
    readonly type: "text";
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly ether?: Record<string, unknown>;
  };
  readonly blocked: boolean;
};

function DemoNode({
  data,
  selected,
}: {
  readonly data: DemoNodeData;
  readonly selected: boolean;
}) {
  return (
    <NodeShell node={data.node} selected={selected} blocked={data.blocked} onEdit={() => {}}>
      <div style={{ display: "flex", height: "100%", flexDirection: "column", gap: 4 }}>
        <div style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: "#EDE6DA" }}>
          station calibration
        </div>
        <div style={{ fontSize: 10, color: "#8a8378", lineHeight: 1.4 }}>
          shared card chrome — border, toolbar, resizer, and flag rail — every
          node type composes its own body inside this shell.
        </div>
      </div>
    </NodeShell>
  );
}

const nodeTypes = { demo: DemoNode };

const shellNode = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  opts: {
    readonly selected?: boolean;
    readonly blocked?: boolean;
    readonly ether?: Record<string, unknown>;
  } = {},
) => ({
  id,
  type: "demo",
  position: { x, y },
  width,
  height,
  selected: opts.selected ?? false,
  data: {
    node: {
      id,
      type: "text" as const,
      text: "",
      x,
      y,
      width,
      height,
      ether: opts.ether,
    },
    blocked: opts.blocked ?? false,
  },
});

// height=440 (not 260): the selected cells show NodeToolbar floating above
// the node — fitView's 0.2 padding only leaves ~14% of the stage height as
// margin, and at 260 that margin (~37px) clips the toolbar pill. 440 gives
// ~63px of headroom, enough for the 8px offset + pill.

export const Default = () => (
  <CanvasStage height={440} nodeTypes={nodeTypes} nodes={[shellNode("n1", 0, 0, 240, 130)]} />
);

export const Selected = () => (
  <CanvasStage
    height={440}
    nodeTypes={nodeTypes}
    nodes={[shellNode("n1", 0, 0, 240, 130, { selected: true })]}
  />
);

export const Blocked = () => (
  <CanvasStage
    height={440}
    nodeTypes={nodeTypes}
    nodes={[
      shellNode("n1", 0, 0, 240, 130, {
        selected: true,
        blocked: true,
        ether: { flags: ["blocker"] },
      }),
    ]}
  />
);

export const AgentSeat = () => (
  <CanvasStage
    height={440}
    nodeTypes={nodeTypes}
    nodes={[
      shellNode("n1", 0, 0, 240, 130, {
        selected: true,
        ether: { entity: { kind: "agent", name: "claude:workshop" } },
      }),
    ]}
  />
);
