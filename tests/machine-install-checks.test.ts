import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { MACHINE_INSTALL_CHECKS, type MachineInstallError } from "../src/shared/machine-install";
import { installCheckWords } from "../src/core/hosts/install-check-words";
import { farLogLine, sendMachine } from "../src/core/hosts/send";
import { machineBundleFiles } from "../src/node/hosts/bundle";
import { LogService } from "../src/node/observability/logger";
import { parseSshEndpoint, parseSshRoute, SshTransport } from "../src/core/ssh";
import { SshTransferExitError } from "../src/core/ssh/service";
import { makeTestLog } from "./support/test-log";

const { log } = makeTestLog();
const DISPOSITIONS = ["staged", "activated", "uncertain", "rolled-back"] as const;
const FAR_TEXT = "bundle must be a directory, not a link: /home/far/.junto/install/incoming";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "junto-install-checks-")));
  await mkdir(join(root, "bin")); await mkdir(join(root, "core"));
  for (const name of ["bin/node", "bin/junto", "core/junto.cjs"]) await writeFile(join(root, name), "fixture\n");
  await chmod(join(root, "bin/node"), 0o755); await chmod(join(root, "bin/junto"), 0o755);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ build: "a".repeat(64), target: "darwin-arm64", node: "26.10.0", appVersion: "1", files: await machineBundleFiles(root) }));
});

/** One send whose far install refuses with these details. */
const refusedWith = async (details: Record<string, unknown>, message = FAR_TEXT): Promise<MachineInstallError> => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target" }));
  const endpoint = await Effect.runPromise(parseSshEndpoint("user@target"));
  const envelope = JSON.stringify({ ok: false, command: "machine install-local", error: { type: "MachineInstallError", message, details: { retryable: false, ...details } } });
  const transport = SshTransport.of({ run: () => Effect.succeed({ stdout: "ready\n", stderr: "" }), connect: () => Effect.die("unexpected"), forward: () => Effect.die("unexpected"), warm: () => Effect.void, teardown: () => Effect.void,
    transfer: (_program, input) => Stream.runDrain(input).pipe(Effect.andThen(Effect.fail(SshTransferExitError.of(endpoint, 1, "", envelope)))),
  });
  return Effect.runPromise(sendMachine(target, { bundle: root }).pipe(Effect.provideService(SshTransport, transport), Effect.provideService(LogService, log), Effect.flip));
};

const fields = (error: MachineInstallError) => {
  const { message: _message, ownWords: _ownWords, failure: _failure, ...rest } = error;
  return { ...rest };
};

describe("the far install's refusal codes", () => {
  it("are one list on both ends: the contract file equals MACHINE_INSTALL_CHECKS, sorted, strings only", () => {
    const file = fileURLToPath(new URL("../src/contract/core/machine-install-checks.json", import.meta.url));
    const listed: unknown = JSON.parse(readFileSync(file, "utf8"));
    expect(listed).toEqual([...MACHINE_INSTALL_CHECKS]);
    expect([...MACHINE_INSTALL_CHECKS]).toEqual([...MACHINE_INSTALL_CHECKS].sort());
    for (const check of MACHINE_INSTALL_CHECKS) expect(check).toMatch(/^[a-z][a-z-]*$/);
  });

  it.each(MACHINE_INSTALL_CHECKS)("%s has words with no path, no far text and no middle dot", (check) => {
    for (const disposition of DISPOSITIONS) {
      const words = installCheckWords(check, disposition);
      if (words === undefined) continue;
      expect(words).not.toMatch(/[/\\~\u00b7]/);
      expect(words).not.toContain("this Mac");
      expect(words).toMatch(/\.$/);
    }
    expect(DISPOSITIONS.some(disposition => installCheckWords(check, disposition) !== undefined)).toBe(true);
  });

  it("a known code gives this side's words with ownWords, and none of the far text or its chain", async () => {
    const error = await refusedWith({ disposition: "staged", check: "bundle-not-directory" });
    expect(error.message).toBe("What arrived there was not a Junto package. Send Junto again.");
    expect(error.ownWords).toBe(true);
    expect(error.failure).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("/home/far");
  });

  it("the code decides only the words: two envelopes that differ only in check decide every other field alike", async () => {
    const details = { disposition: "activated", transitions: [{ step: "selected", build: "a".repeat(64) }], runningSeats: 2 };
    const coded = await refusedWith({ ...details, check: "seats-did-not-stop" });
    const plain = await refusedWith(details);
    expect(coded.ownWords).toBe(true);
    expect(plain.ownWords).toBeUndefined();
    expect(fields(coded)).toEqual(fields(plain));
  });

  it.each([
    ["an unknown code", "a-code-from-a-newer-build"],
    ["a code with other characters", "Bundle_Mismatch"],
    ["a code over 64 bytes", `bundle-${"x".repeat(64)}`],
    ["a code that is not a string", 7],
  ])("%s is dropped, the decode still succeeds, and the words stay unmarked", async (_label, check) => {
    const error = await refusedWith({ disposition: "staged", check });
    expect(error.ownWords).toBeUndefined();
    expect(error.disposition).toBe("staged");
    expect(error.message).toContain("bundle must be a directory");
  });

  it("no code keeps today's unmarked far text", async () => {
    const error = await refusedWith({ disposition: "uncertain" });
    expect(error.ownWords).toBeUndefined();
    expect(error.message).toContain("bundle must be a directory");
  });

  it("nothing changed is claimed only on a staged or rolled-back disposition", async () => {
    const uncertain = await refusedWith({ disposition: "uncertain", check: "database-copy-failed" });
    expect(uncertain.message).toBe("Junto could not keep a copy of its data there. Check it again.");
    expect(uncertain.message).not.toContain("nothing changed");
    const staged = await refusedWith({ disposition: "staged", check: "database-copy-failed" });
    expect(staged.message).toContain("so nothing changed");
    expect(installCheckWords("database-not-private", "rolled-back")).toContain("so nothing changed");
    expect(installCheckWords("database-not-private", "activated")).toBe("Its Junto data is not private to its account. Check it again.");
  });

  it("installed-not-started claims nothing runs only when activated, and start-rolled-back speaks only when rolled back", () => {
    expect(installCheckWords("installed-not-started", "activated")).toContain("nothing runs there now");
    expect(installCheckWords("installed-not-started", "uncertain")).toBe("The new build did not start there. Update Junto on this machine, then send again.");
    expect(installCheckWords("start-rolled-back", "rolled-back")).toContain("may not be running");
    for (const disposition of ["staged", "activated", "uncertain"] as const) expect(installCheckWords("start-rolled-back", disposition)).toBeUndefined();
  });

  it("a start-rolled-back on another disposition keeps the far text unmarked", async () => {
    const error = await refusedWith({ disposition: "uncertain", check: "start-rolled-back" });
    expect(error.ownWords).toBeUndefined();
  });

  it("the far text is logged as one line, without control characters, at most 2 KB", () => {
    const line = farLogLine(`first\nsecond\r\u001b[31mred\u2028${"x".repeat(5000)}`);
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(line.startsWith("first second")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(2048);
  });

  it("the far text's bidi controls cannot reorder its log line", () => {
    const line = farLogLine("ok \u202ereversed\u202c \u2066isolated\u2069 \u202a\u202b\u202d\u2067\u2068end");
    expect(line).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    // scrubText's control step drops them first; farLogLine's own class holds the line if that step ever changes.
    expect(line).toBe("ok reversed isolated end");
  });
});
