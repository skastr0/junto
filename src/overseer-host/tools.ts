import { Result, Schema } from "effect";
import {
  decodeOverseerArgs,
  OverseerArgsSchemas,
  type OverseerOperation,
} from "../shared/overseer-control";

/** Small controller surface; every call is still decoded and admitted in main. */
export const OVERSEER_HOST_OPERATIONS = [
  "canvas.list", "canvas.read", "canvas.digest", "canvas.batch",
  "node.get", "node.create", "node.configure", "node.move", "node.resize",
  "edge.verbs", "edge.connect", "edge.configure", "edge.disconnect",
  "tasks.list", "tasks.create", "tasks.show", "tasks.describe", "tasks.update",
  "agent.list", "agent.get", "agent.start", "agent.prompt", "agent.output", "agent.interrupt",
  "board.list", "board.tags", "pad.digest", "artifact.list", "artifact.get",
] as const satisfies ReadonlyArray<OverseerOperation>;

const byName = new Map<string, OverseerOperation>(OVERSEER_HOST_OPERATIONS.map((operation) => [operation.replaceAll(".", "__"), operation]));

export const overseerHostTools = () => OVERSEER_HOST_OPERATIONS.map((operation) => ({
  type: "function" as const,
  name: operation.replaceAll(".", "__"),
  description: `Vellum Command ${operation}. Results are verified service receipts. agent.prompt proves delivery only, never worker acceptance or completion.`,
  parameters: Schema.toJsonSchemaDocument(OverseerArgsSchemas[operation]).schema,
  // The existing Effect schemas own optionality and validation.
  strict: false,
}));

export const overseerHostControlTools = [
  { type: "function", name: "request__steer", description: "Correct one prior request. Invalidates its pending operations and starts a revised interpretation.", strict: false,
    parameters: { type: "object", properties: { targetRequestId: { type: "string" }, text: { type: "string" } }, required: ["targetRequestId", "text"], additionalProperties: false } },
  { type: "function", name: "request__cancel", description: "Cancel one named request. Committed effects remain recorded; worker cancellation requires a separate verified interrupt.", strict: false,
    parameters: { type: "object", properties: { targetRequestId: { type: "string" } }, required: ["targetRequestId"], additionalProperties: false } },
  { type: "function", name: "actions__stop", description: "Close admission to all new controller actions for this Live session immediately.", strict: false,
    parameters: { type: "object", properties: {}, additionalProperties: false } },
] as const;

export const decodeHostTool = (name: string, raw: string): { operation: OverseerOperation; args: unknown } => {
  const operation = byName.get(name);
  if (operation === undefined) throw new Error("the backend requested a tool outside the controller catalog");
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("controller tool arguments exceed the byte limit");
  const args: unknown = JSON.parse(raw);
  const decoded = decodeOverseerArgs(operation, args);
  if (Result.isFailure(decoded)) throw new Error(decoded.failure.message);
  return { operation, args: decoded.success };
};
