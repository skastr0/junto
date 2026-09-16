import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  enumeratedToolDirs,
  mergePath,
  resolvedSpawnEnv,
  resolvedSpawnEnvSync,
  staticPathDirs,
} from "../src/main/junto/adapters/exec";

// The spawn plane resolves user-installed CLIs under a packaged/launchd/Finder
// launch by merging inherited PATH, operator tool directories, enumerated
// version-manager install roots, and a static fallback floor. The merge logic
// is pure so the ordering, deduplication, and floor are testable without
// executing any user-controlled shell code.

const HOME = "/home/tester";
const split = (p: string) => p.split(":");

describe("staticPathDirs", () => {
  it("lists the guaranteed floor in priority order", () => {
    expect(staticPathDirs(HOME)).toEqual([
      "/home/tester/.local/bin",
      "/home/tester/.kimi-code/bin",
      "/home/tester/.bun/bin",
      "/home/tester/.grok/bin",
      "/home/tester/.volta/bin",
      "/home/tester/.cargo/bin",
      "/home/tester/.deno/bin",
      "/home/tester/go/bin",
      "/home/tester/bin",
      "/home/tester/.local/share/pnpm",
      "/home/tester/Library/pnpm",
      "/home/tester/.nix-profile/bin",
      "/home/tester/.local/share/mise/shims",
      "/home/tester/.asdf/shims",
      "/home/tester/.pyenv/shims",
      "/home/tester/.rbenv/shims",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/opt/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]);
  });
});

describe("enumeratedToolDirs", () => {
  it("returns nothing for a home with no version-manager roots", () => {
    expect(enumeratedToolDirs("/nonexistent/home")).toEqual([]);
  });

  it("enumerates real and symlinked version dirs under known roots", () => {
    const home = mkdtempSync(join(tmpdir(), "junto-vm-roots-"));
    try {
      const miseNode = join(home, ".local", "share", "mise", "installs", "node");
      mkdirSync(join(miseNode, "22.11.0", "bin"), { recursive: true });
      mkdirSync(join(miseNode, "24.2.0", "bin"), { recursive: true });
      // Version managers publish aliases like `current`/`latest` as symlinks.
      symlinkSync(join(miseNode, "24.2.0"), join(miseNode, "latest"));
      const nvmNode = join(home, ".nvm", "versions", "node");
      mkdirSync(join(nvmNode, "v20.10.0", "bin"), { recursive: true });

      const dirs = enumeratedToolDirs(home);
      expect(dirs).toContain(join(miseNode, "latest", "bin"));
      expect(dirs).toContain(join(miseNode, "24.2.0", "bin"));
      expect(dirs).toContain(join(miseNode, "22.11.0", "bin"));
      expect(dirs).toContain(join(nvmNode, "v20.10.0", "bin"));
      // newest-name first within one manager's install root
      expect(dirs.indexOf(join(miseNode, "24.2.0", "bin"))).toBeLessThan(
        dirs.indexOf(join(miseNode, "22.11.0", "bin")),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("mergePath", () => {
  it("inherited PATH entries come first, in order", () => {
    const merged = mergePath({
      currentPath: "/opt/homebrew/bin:/home/tester/.local/bin:/usr/bin:/bin",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs[0]).toBe("/opt/homebrew/bin");
    expect(dirs[1]).toBe("/home/tester/.local/bin");
    // inherited PATH remains ahead of the static-only remainder.
    expect(dirs.indexOf("/usr/bin")).toBeLessThan(dirs.indexOf("/usr/local/bin"));
    // every static-floor dir is still present after the merge.
    for (const dir of staticPathDirs(HOME)) expect(dirs).toContain(dir);
  });

  it("launchd's minimal PATH gains the static floor", () => {
    const merged = mergePath({
      currentPath: "/usr/bin:/bin:/usr/sbin:/sbin",
      home: HOME,
    });
    const dirs = split(merged);
    // The two dirs that actually resolve hermes/codex/bun tooling.
    expect(dirs).toContain("/home/tester/.local/bin");
    expect(dirs).toContain("/home/tester/.local/share/mise/shims");
    expect(dirs).toContain("/opt/homebrew/bin");
    // inherited minimal PATH is preserved, still first.
    expect(dirs.slice(0, 4)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("empty current PATH (undefined) still yields the full static floor", () => {
    const merged = mergePath({ home: HOME });
    expect(split(merged)).toEqual(staticPathDirs(HOME));
  });

  it("places explicit tool directories after inherited PATH and before the static floor", () => {
    const merged = mergePath({
      currentPath: "/usr/bin:/bin",
      home: HOME,
      extraDirs: ["/opt/custom/bin", " /opt/custom/bin "],
    });
    const dirs = split(merged);
    expect(dirs.slice(0, 3)).toEqual(["/usr/bin", "/bin", "/opt/custom/bin"]);
    expect(dirs.indexOf("/opt/custom/bin")).toBeLessThan(
      dirs.indexOf("/home/tester/.local/bin"),
    );
  });

  it("enumerated install roots sit after operator dirs and before the static floor", () => {
    const merged = mergePath({
      currentPath: "/usr/bin:/bin",
      home: HOME,
      extraDirs: ["/opt/custom/bin"],
      enumeratedDirs: [
        "/home/tester/.local/share/mise/installs/node/24/bin",
        "/home/tester/.nvm/versions/node/v22.11.0/bin",
      ],
    });
    const dirs = split(merged);
    const realInstall = "/home/tester/.local/share/mise/installs/node/24/bin";
    expect(dirs.indexOf("/opt/custom/bin")).toBeLessThan(dirs.indexOf(realInstall));
    // A real version-manager install outranks the same manager's shim dir.
    expect(dirs.indexOf(realInstall)).toBeLessThan(
      dirs.indexOf("/home/tester/.local/share/mise/shims"),
    );
    expect(dirs.indexOf(realInstall)).toBeLessThan(dirs.indexOf("/opt/homebrew/bin"));
  });

  it("dedups, keeping first occurrence", () => {
    const merged = mergePath({
      currentPath: "/a:/a:/b:/b:/c",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs.slice(0, 3)).toEqual(["/a", "/b", "/c"]);
    // no dir appears twice across the whole merged PATH.
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("drops empty segments and trims whitespace", () => {
    const merged = mergePath({
      currentPath: " /x : : /y ",
      home: HOME,
    });
    const dirs = split(merged);
    expect(dirs[0]).toBe("/x");
    expect(dirs[1]).toBe("/y");
    expect(dirs).not.toContain("");
    expect(dirs).not.toContain(" ");
  });
});

describe("resolvedSpawnEnvSync", () => {
  it("returns an env whose PATH carries the real static floor without spawning a shell", () => {
    const env = resolvedSpawnEnvSync();
    const dirs = split(env.PATH ?? "");
    expect(dirs).toContain(`${homedir()}/.local/bin`);
    expect(dirs).toContain(`${homedir()}/.local/share/mise/shims`);
  });
});

describe("resolvedSpawnEnv", () => {
  const originalPath = process.env.PATH;
  afterAll(() => {
    process.env.PATH = originalPath;
  });

  it("resolves an env containing the static floor and mutates process.env.PATH once", async () => {
    const env = await resolvedSpawnEnv();
    const dirs = split(env.PATH ?? "");
    // Deterministic without invoking a shell: the static floor is appended.
    expect(dirs).toContain(`${homedir()}/.local/bin`);
    expect(dirs).toContain(`${homedir()}/.local/share/mise/shims`);
    // The single documented mutation: process.env.PATH now equals the merge.
    expect(process.env.PATH).toBe(env.PATH);
    // Memoized: a second call returns the same object.
    const again = await resolvedSpawnEnv();
    expect(again).toBe(env);
  });
});
