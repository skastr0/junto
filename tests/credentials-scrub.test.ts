import { expect, it } from "vitest";
import { knownSecretValues, launchSecretValues, registerKnownSecrets, releaseKnownSecrets, scrubMessage, scrubText, StderrTail } from "../src/main/junto/credentials/scrub";

const tail = (text: string, known?: ReadonlyArray<string | undefined>) => {
  const window = new StderrTail();
  window.push(Buffer.from(text));
  return window.read(known);
};

it("step 1 holds the last 64 KiB and drops a partial first line", () => {
  const window = new StderrTail();
  window.push(Buffer.from("PARTIAL-LINE-START " + "x".repeat(64 * 1024) + "\nlast line\n"));
  const read = window.read([]);
  expect(read.text).toBe("last line");
  expect(read.cut).toBe(true);
});

it("step 2 removes escape sequences whole, controls and bidi, and a carriage return ends a line", () => {
  const text = scrubText("a\u001b[31mred\u001b[0m\u001b]0;TITLE\u0007b\u0000c\u007fd\u0085e‮f⁧g\rnext\tTab", []);
  expect(text).toBe("aredbcdefg\nnext\tTab");
  expect(text).not.toContain("TITLE");
});

it("step 3 redacts known values: secrets from four characters, environment values from six", () => {
  const known = knownSecretValues(["s3cr"], { GH_TOKEN_VALUE: "abcdef1", SHORT: "wxyz5", HOME: "/Users/someone", LC_ALL: "en_US.UTF-8" });
  const text = scrubText("s3cr abcdef1 wxyz5 /Users/someone en_US.UTF-8", known);
  expect(text).toBe("[redacted] [redacted] wxyz5 /Users/someone en_US.UTF-8");
});

it("step 3 keeps Junto's own names and paths and short region words, and searches the credential", () => {
  const known = knownSecretValues(["tok4"], { JUNTO_SEAT: "remote-send", JUNTO_SOCKET: "/Users/someone/.junto/core/control.sock", JUNTO_HOME: "/Users/someone/.junto-mini", COLORTERM: "truecolor", REGION_STAGE: "prod", JUNTO_WORK_TOKEN: "work-token-value", JUNTO_TOKEN: "legacy-token-value", JUNTO_FUTURE_KEY: "future-key-value" });
  expect(scrubText("remote-send at /Users/someone/.junto-mini/core/control.sock truecolor prod tok4 work-token-value legacy-token-value future-key-value", known))
    .toBe("remote-send at /Users/someone/.junto-mini/core/control.sock truecolor prod [redacted] [redacted] [redacted] [redacted]");
});

it("step 3 searches the values a launch registered until their generation ends", () => {
  registerKnownSecrets("seat:b1@1", ["gen-credential-1", "rs1x"]);
  expect(scrubText("seat env had gen-credential-1 and rs1x")).toBe("seat env had [redacted] and [redacted]");
  expect(launchSecretValues(["tok4"], {})).toEqual(["tok4"]);
  releaseKnownSecrets("seat:b1@1");
  expect(scrubText("seat env had gen-credential-1")).toBe("seat env had gen-credential-1");
});

it("step 4 redacts credential shapes Junto does not know", () => {
  const seeded = [
    "Authorization: Basic dXNlcjpwYXNz",
    "curl -H 'Bearer abc.def-ghi'",
    "https://user:hunter2@example.com/path",
    "JUNTO_WORK_TOKEN=plainvalue",
    "session: cookievalue",
    '{"api_key": "Zq81LmP0wx", "token":"short1x"}',
    "aws wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAkeybody\n-----END OPENSSH PRIVATE KEY-----",
    "sk-proj1234 ghp_abc123 github_pat_11AB xoxb-1-2 AKIAABCDEFGHIJKLMNOP ops_abc",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    "digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  ].join("\n");
  const text = scrubText(seeded, []);
  for (const secret of ["dXNlcjpwYXNz", "abc.def-ghi", "hunter2", "plainvalue", "cookievalue", "Zq81LmP0wx", "short1x", "K7MDENG", "AAAAkeybody", "sk-proj1234", "ghp_abc123", "github_pat_11AB", "xoxb-1-2", "AKIAABCDEFGHIJKLMNOP", "ops_abc", "eyJhbGci", "9f86d081884c7d659a2f"]) {
    expect(text).not.toContain(secret);
  }
  expect(text).toContain("https://[redacted]@example.com/path");
  expect(scrubText("TMPDIR=/var/folders/f5/yx3b1gkj5d7h9kq2m4n6p8r0t2v4x6z8/T/junto", [])).toBe("TMPDIR=/var/folders/f5/yx3b1gkj5d7h9kq2m4n6p8r0t2v4x6z8/T/junto".replace("yx3b1gkj5d7h9kq2m4n6p8r0t2v4x6z8", "[redacted]"));
  expect(scrubText("open ~/x/node_modules/node-pty/build/Release/pty.node", [])).toBe("open ~/x/node_modules/node-pty/build/Release/pty.node");
  expect(scrubText("/Users/someone/Projects/junto/node_modules/node-pty/build/Release/pty.node", [])).toBe("/Users/someone/Projects/junto/node_modules/node-pty/build/Release/pty.node");
});

it("Junto ids survive in free text; UUIDs and hex digests do not", () => {
  expect(scrubText("seat agent-01M4G59ER01QPV3WBTEK3Z84TP in region-01M4FA8TRP5WCTVC26GVKPC5C2", [])).toBe("seat agent-01M4G59ER01QPV3WBTEK3Z84TP in region-01M4FA8TRP5WCTVC26GVKPC5C2");
  expect(scrubText("key 01a1202e-880e-7391-9903-bb0931c63820", [])).toBe("key [redacted]");
  expect(scrubText("agent-01M4G59ER01QPV3WBTEK3Z84TPx9f86d081884c7d659a2feaa0c55ad015", [])).toBe("[redacted]");
});

it("step 5 keeps the last 40 lines and 4 KiB, scrubbing the whole window before the cut", () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
  const read = tail(lines.join("\n") + "\n", []);
  expect(read.text.split("\n")).toEqual(lines.slice(20));
  expect(read.cut).toBe(true);
  const wide = tail(Array.from({ length: 30 }, (_, index) => `${index} ${"w".repeat(300)}`).join("\n"), []);
  expect(Buffer.byteLength(wide.text)).toBeLessThanOrEqual(4096);
  expect(wide.text.startsWith(String(wide.text.split(" ")[0]))).toBe(true);
  // A token split by the window would leave half visible if the cut ran first.
  const token = tail(`password=${"z".repeat(10)}\nok\n`, []);
  expect(token.text).toBe("password=[redacted]\nok");
});

/**
 * Linear is a claim about the ratio of two sizes, not about the clock: eight
 * times the input costs about eight times as long, and a quadratic about 64.
 * The rounds alternate sizes, so a pause of a loaded runner falls on both,
 * and the best of nine of each is its cost. No absolute bound: a loaded
 * machine stretches both sizes alike, and only the ratio is the claim. A small
 * size under the floor counts as the floor, so a near-zero time cannot make a
 * linear scrub look quadratic.
 */
const SMALL = 16 * 1024, SCALE = 8;
const LINEAR_BOUND = 24;
const FLOOR_MS = 0.5;
const elapsed = (run: (size: number) => void, size: number) => { const started = performance.now(); run(size); return performance.now() - started; };
const linearRatio = (scrub: (size: number) => void, smallSize = SMALL, rounds = 9): number => {
  const largeSize = smallSize * SCALE;
  elapsed(scrub, smallSize); elapsed(scrub, largeSize);
  const small: number[] = [], large: number[] = [];
  for (let round = 0; round < rounds; round += 1) { small.push(elapsed(scrub, smallSize)); large.push(elapsed(scrub, largeSize)); }
  const best = { small: Math.min(...small), large: Math.min(...large) };
  return best.large / Math.max(best.small, FLOOR_MS);
};
const expectLinear = (scrub: (size: number) => void) => {
  expect(linearRatio(scrub)).toBeLessThan(LINEAR_BOUND);
};

it("the linear bound fails a quadratic", () => {
  let sink = 0;
  const quadratic = (n: number) => {
    // Kept a small integer: past 2^31 the engine leaves its fast path mid-run, and the sizing would not measure what it times.
    for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) sink = (sink + (i ^ j)) | 0;
  };
  // Sized from the floor, not from this machine: the small size grows until even its fastest of three runs is four floors long,
  // so the clamp never shortens the ratio, and a faster machine runs a larger n in the same time.
  const fastest = (n: number) => Math.min(elapsed(quadratic, n), elapsed(quadratic, n), elapsed(quadratic, n));
  let n = 64;
  while (fastest(n) < 4 * FLOOR_MS) n = Math.ceil(n * 1.25);
  expect(linearRatio(quadratic, n, 5)).toBeGreaterThanOrEqual(LINEAR_BOUND);
  expect(Number.isInteger(sink)).toBe(true);
  // Sized to under a second; a loaded runner may stretch it, and only the ratio is the claim.
}, 15_000);

it("a long run costs linear time, so a peer's message cannot stall the main thread", () => {
  expectLinear(size => scrubMessage("x".repeat(size), []));
});

it("a message is one scrubbed line of at most 1 KiB, its cut marked", () => {
  expect(scrubMessage("first\nsecond token=abc")).toBe("first second token=[redacted]");
  const long = scrubMessage("m".repeat(5000), []);
  expect(long.length).toBe(1024);
  expect(long.endsWith(" [cut]")).toBe(true);
});

it("redacts a UUID whatever its digits, inside a path too", () => {
  expect(scrubText("could not remove /vault/00000000-0000-4000-8000-000000000001: x")).toBe("could not remove /vault/[redacted]: x");
  expect(scrubText("id 6F1C2A9E-3B4D-4E5F-8A7B-1C2D3E4F5A6B")).toBe("id [redacted]");
  expect(scrubText("seat-01M4G8HNHWGG9BM2YF30KMTZYZ stays")).toBe("seat-01M4G8HNHWGG9BM2YF30KMTZYZ stays");
});

it("keeps a stack frame's bundle path whole and judges each segment of a path", () => {
  const build = "a1".repeat(32);
  const frame = `at logStartOutcome (/Users/someone/.junto/machine/builds/${build}-darwin-arm64/core/junto.cjs:69363:144)`;
  expect(scrubMessage(frame)).toBe(frame);
  expect(scrubText(`key at /tmp/x/${"Ab9".repeat(12)}/y`)).toBe("key at /tmp/x/[redacted]/y");
  expect(scrubText(`/Users/someone/.cache/${"Ab9".repeat(12)}`)).toBe("/Users/someone/.cache/[redacted]");
});

it("reads a path in GNU curly quotes as a path, judged per segment", () => {
  // remote-verify's Linux wrong-root line, with the path the mini kept whole.
  const build = "a1".repeat(32);
  const line = `exit code 127: /usr/bin/env: ‘/home/user/.junto/machine/builds/${build}-linux-x64/bin/node’: No such file or directory`;
  // No known values: this process's environment is the runner's (a run through env carries _=/usr/bin/env).
  expect(scrubMessage(line, [])).toBe(line);
  expect(scrubText(`cannot open “/home/user/.cache/${"Ab9".repeat(12)}”`, [])).toBe("cannot open “/home/user/.cache/[redacted]”");
});

it("judges one 64 KiB path token in linear time", () => {
  expectLinear(size => {
    const token = "/" + ("Ab1".repeat(11) + ".").repeat(Math.ceil(size / 34));
    scrubText(token);
    const tail = new StderrTail();
    tail.push(new TextEncoder().encode(token));
    tail.read();
  });
});
