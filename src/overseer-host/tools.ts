import { Result, Schema } from "effect";
import {
  decodeOverseerArgs,
  OverseerArgsSchemas,
  type OverseerOperation,
} from "../shared/overseer-control";
import { OVERSEER_HOST_OPERATIONS } from "../shared/overseer-host-control";
export { OVERSEER_HOST_OPERATIONS } from "../shared/overseer-host-control";

const byName = new Map<string, OverseerOperation>(OVERSEER_HOST_OPERATIONS.map((operation) => [operation.replaceAll(".", "__"), operation]));

export const overseerHostTools = () => OVERSEER_HOST_OPERATIONS.map((operation) => {
  const document = Schema.toJsonSchemaDocument(OverseerArgsSchemas[operation]);
  return {
    type: "function" as const,
    name: operation.replaceAll(".", "__"),
    description: `Vellum Command ${operation}. Results are verified service receipts.`,
    // Effect's empty Struct also permits an array; Responses tools require an
    // object at the root. Keep the existing schema for every nonempty contract.
    parameters: operation === "canvas.list"
      ? { type: "object", properties: {}, additionalProperties: false }
      : { ...document.schema, ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }) },
    strict: false,
  };
});

export const overseerHostControlTools = [
  { type: "function", name: "request__steer", description: "Correct one prior request. Invalidates its pending operations and starts a revised interpretation.", strict: false,
    parameters: { type: "object", properties: { targetRequestId: { type: "string" }, text: { type: "string" } }, required: ["targetRequestId", "text"], additionalProperties: false } },
  { type: "function", name: "request__cancel", description: "Cancel one named request. Committed effects remain recorded.", strict: false,
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
