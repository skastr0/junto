/**
 * Main's side of the operator's signals: the secret form's write, in the
 * core, asks main for the two things it cannot do there, a tool run and the
 * login shell's PATH. The value never crosses that call, only the tool call
 * does.
 */
import type { ToolCall, ToolResult } from "../../junto/region-env/tool";
import { hostOps, type HostOp } from "../host-ops";

declare module "../host-ops" {
  interface HostOps {
    /** One tool run, as main's own process plane makes it. */
    "signals.tool.run": HostOp<{ readonly call: ToolCall }, ToolResult>;
    /** The login shell's PATH, as main resolves it. */
    "signals.tool.path": HostOp<Record<string, never>, string | undefined>;
  }
}

let serving: (() => void) | undefined;

/** Main's side: one server for the core's two asks, answered from main's own tool plane. */
export const serveSignalTools = (ports: {
  readonly run: (call: ToolCall) => Promise<ToolResult>;
  readonly path: () => Promise<string | undefined>;
}): (() => void) =>
  (serving ??= hostOps({
    "signals.tool.run": ({ call }) => ports.run(call),
    "signals.tool.path": () => ports.path(),
  }));
