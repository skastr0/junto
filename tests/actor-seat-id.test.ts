import { Schema } from "effect";
import { expect, it } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";

it("preserves the installed seat identity while separating machines and bindings", () => {
  const installation = Schema.decodeUnknownSync(InstallationId)("install-command");
  const other = Schema.decodeUnknownSync(InstallationId)("install-other");
  expect(deriveActorSeatId(installation, "binding-1")).toBe(
    "seat_2823676a782068a3894ae26b8740abea567259c6396ad52c4058c73be1fd615d",
  );
  expect(deriveActorSeatId(installation, " binding-1 ")).toBe(deriveActorSeatId(installation, "binding-1"));
  expect(deriveActorSeatId(other, "binding-1")).not.toBe(deriveActorSeatId(installation, "binding-1"));
  expect(deriveActorSeatId(installation, "binding-2")).not.toBe(deriveActorSeatId(installation, "binding-1"));
  expect(() => deriveActorSeatId(installation, " ")).toThrow("non-empty");
});
