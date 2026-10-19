import { expect, it } from "vitest";
import { scrubMessage } from "../src/main/junto/credentials/scrub";
import { isLogIdAnnotation } from "../src/shared/machine-log";

// The measured shape: `boat_` and 64 base64url characters; a minted key may carry "-".
const KEY = `boat_${"Ab3_".repeat(16)}`;
const DASHED = `boat_${"x9-Q".repeat(16)}`;
const OLD = `box_${"Q20HbkbY".repeat(4)}`;

it("redacts a Boat key at either end of the text and in the middle", () => {
  for (const key of [KEY, DASHED, OLD]) {
    for (const text of [`${key} was refused`, `refused: ${key}`, `the key ${key} was refused`]) {
      const scrubbed = scrubMessage(text);
      expect(scrubbed).not.toContain(key.slice(5, 20));
      expect(scrubbed).not.toContain(key.slice(-12));
      expect(scrubbed).toContain("[redacted]");
    }
  }
});

it("keeps a sandbox id and short words that start like a key", () => {
  expect(scrubMessage("sandbox bx_gh9ra7h4 is asleep")).toBe("sandbox bx_gh9ra7h4 is asleep");
  expect(scrubMessage("boat_ and box_ are prefixes")).toBe("boat_ and box_ are prefixes");
});

it("cuts what follows the path of a Boat link", () => {
  const scrubbed = scrubMessage("open https://boat.dev/cli/login?code=Zq81kd2&state=abc to sign in");
  expect(scrubbed).toBe("open https://boat.dev/cli/login?[redacted] to sign in");
  expect(scrubMessage("https://app-3000.on.boat.dev/?_token=abcdef")).not.toContain("abcdef");
});

it("holds Boat ids in logs to their own shapes", () => {
  expect(isLogIdAnnotation("sandboxId", "bx_gh9ra7h4")).toBe(true);
  expect(isLogIdAnnotation("sandboxId", "not-a-sandbox")).toBe(false);
  expect(isLogIdAnnotation("boatKeyId", "84d50956-645b-4d4c-9bcc-06e52d01626c")).toBe(true);
  expect(isLogIdAnnotation("boatKeyId", KEY)).toBe(false);
  expect(isLogIdAnnotation("bindingId", "b-1")).toBe(true);
});
