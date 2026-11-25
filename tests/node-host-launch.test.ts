import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHostEntry, nodeHostLaunch } from "../src/core/term/templates/node-host";
import { JUNTO_OVERSEER_TEMPLATE } from "../src/shared/managed-terminal-templates";
import { resolveManagedLaunch } from "../src/shared/managed-terminal-launch";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const buildWith = (name: string): string => {
  const root = mkdtempSync(join(tmpdir(), "junto-node-host-"));
  roots.push(root);
  mkdirSync(join(root, "out", "main"), { recursive: true });
  writeFileSync(nodeHostEntry(name, root), "");
  return root;
};

describe("a Live seat runs the build's overseer host on Junto's Node", () => {
  it("launches the overseer-host entry, not a junto subcommand", () => {
    expect(JUNTO_OVERSEER_TEMPLATE.argvSpec.nodeHost).toBe(true);
    expect(resolveManagedLaunch(JUNTO_OVERSEER_TEMPLATE, { cwd: "/work" }, {}).argv).toEqual(["overseer-host"]);
  });

  it("runs the entry beside the core on the Node, with what that Node needs to be Node", () => {
    const root = buildWith("overseer-host");
    const electron = { command: "/repo/node_modules/electron/dist/electron", env: { ELECTRON_RUN_AS_NODE: "1" } };
    expect(nodeHostLaunch("overseer-host", root, () => electron)).toEqual({
      file: electron.command,
      args: [join(root, "out", "main", "overseer-host.js")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(nodeHostLaunch("overseer-host", root, () => ({ command: "/opt/junto/bin/node" }))).toEqual({
      file: "/opt/junto/bin/node",
      args: [join(root, "out", "main", "overseer-host.js")],
      env: {},
    });
  });

  it("does not resolve without a Node to run it or a build that holds it", () => {
    const root = buildWith("overseer-host");
    expect(nodeHostLaunch("overseer-host", root, () => undefined)).toBeUndefined();
    const empty = mkdtempSync(join(tmpdir(), "junto-no-build-"));
    roots.push(empty);
    expect(nodeHostLaunch("overseer-host", empty, () => ({ command: "/opt/junto/bin/node" }))).toBeUndefined();
  });
});
