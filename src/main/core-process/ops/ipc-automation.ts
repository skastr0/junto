/**
 * The Automations pane's reads and writes (automation/ipc.ts), answered in
 * the core where the automation store and the one write path live. Every
 * applied write, the CLI's too, is published on the pane's own channel, which
 * main relays to the windows.
 */
import { Effect } from "effect";
import type {
  AutomationApplyResponse,
  AutomationCodePutResponse,
  AutomationCodeReadResponse,
  AutomationFiringsResponse,
  AutomationListResponse,
} from "@shared/automation";
import { IPC_CHANNELS } from "@shared/ipc";
import { coreRunner } from "../../core-runner";
import { automationIpcHandlers } from "../../junto/automation/ipc";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

type Asked = { readonly canvasName: unknown; readonly input: unknown };

declare module "../ops" {
  interface CoreOps {
    "ipc.automation.list": CoreOp<Asked, AutomationListResponse>;
    "ipc.automation.firings": CoreOp<Asked, AutomationFiringsResponse>;
    "ipc.automation.apply": CoreOp<Asked, AutomationApplyResponse>;
    "ipc.automation.codePut": CoreOp<Asked, AutomationCodePutResponse>;
    "ipc.automation.codeRead": CoreOp<Asked, AutomationCodeReadResponse>;
  }
}

// Built at load, so a write from the CLI reaches the panes before any pane asks.
const handlers = automationIpcHandlers(
  // The core's runtime carries every service the automation write path asks for.
  (effect) => coreRunner.runPromise(effect as Effect.Effect<never, never, never>),
  (event) => publish(IPC_CHANNELS.automationsChanged, event),
);

const answer = <A>(ask: () => Promise<A>) => Effect.tryPromise({ try: ask, catch: (cause) => cause });

coreOps({
  "ipc.automation.list": ({ canvasName, input }) => answer(() => handlers.list(canvasName, input)),
  "ipc.automation.firings": ({ canvasName, input }) => answer(() => handlers.firings(canvasName, input)),
  "ipc.automation.apply": ({ canvasName, input }) => answer(() => handlers.apply(canvasName, input)),
  "ipc.automation.codePut": ({ canvasName, input }) => answer(() => handlers.codePut(canvasName, input)),
  "ipc.automation.codeRead": ({ canvasName, input }) => answer(() => handlers.codeRead(canvasName, input)),
});
