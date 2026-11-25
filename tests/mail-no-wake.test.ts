import { describe, expect, it } from "vitest";
import { mailExtensionMetadata, mailHoldsWake, type MailExtension } from "../src/shared/crew";

const stamp: MailExtension = {
  mailKind: "prompt",
  fromSeat: `seat_${"a".repeat(64)}` as MailExtension["fromSeat"],
  senderGeneration: "operator",
  senderHarness: "unknown",
};

describe("a mail row's noWake mark", () => {
  it("is carried by the metadata a sender stamps, and read back at delivery", () => {
    expect(mailHoldsWake(mailExtensionMetadata({ ...stamp, noWake: true }))).toBe(true);
  });

  it("is absent on mail that wakes, and on rows with no mail extension", () => {
    expect(mailExtensionMetadata(stamp)).not.toHaveProperty("noWake");
    expect(mailHoldsWake(mailExtensionMetadata(stamp))).toBe(false);
    expect(mailHoldsWake({ noWake: true })).toBe(false);
    expect(mailHoldsWake(undefined)).toBe(false);
  });
});
