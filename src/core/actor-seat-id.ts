import { createHash } from "node:crypto";
import { Schema } from "effect";
import { ActorSeatId } from "@shared/actor-seat";
import type { InstallationId } from "@shared/installation-id";

/** Stable installation-and-binding identity, never a credential. */
export const deriveActorSeatId = (
  installationId: InstallationId,
  bindingId: string,
): ActorSeatId => {
  const binding = bindingId.trim();
  if (binding.length === 0) throw new Error("actor bindingId must be non-empty");
  const digest = createHash("sha256")
    .update(JSON.stringify(["junto/actor-seat/v1", installationId, binding]), "utf8")
    .digest("hex");
  return Schema.decodeUnknownSync(ActorSeatId)(`seat_${digest}`);
};
