import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildNodeKindDoc, PORT_DESCRIPTIONS } from "../src/shared/vellum-docs";

const readPadGuide = () =>
  readFile(new URL("../docs/pad.md", import.meta.url), "utf8");

describe("pad operator and agent docs", () => {
  it("docs node pad names the shipped ports and refusals", () => {
    const node = buildNodeKindDoc("pad")!;
    expect(node).toContain("pad.read");
    expect(node).toContain("pad.patch");
    expect(node).toContain(PORT_DESCRIPTIONS["pad.read"]);
    expect(node).toContain(PORT_DESCRIPTIONS["pad.patch"]);
    expect(node).toContain("vellum-command pad read");
    expect(node).toContain("vellum-command pad patch");
    expect(node).toContain("vellum-command pad look-here");
    expect(node).toContain("vellum-command pad tagged");
    expect(node).toContain("ink or image");
    expect(node).toContain("inbound actor");
    expect(node).not.toMatch(/\bVellum\b(?! Command)/);
  });

  it("docs/pad.md matches shipped ports, CLI verbs, and refusals", async () => {
    const guide = await readPadGuide();
    expect(guide).toContain("Vellum Command pad");
    expect(guide).toContain("pad.read");
    expect(guide).toContain("pad.patch");
    for (const verb of ["read", "patch", "digest", "svg", "look-here", "get", "tagged"]) {
      expect(guide).toContain(`vellum-command pad ${verb}`);
    }
    expect(guide).toContain("agents cannot upsert ink");
    expect(guide).toContain("agents cannot upsert images");
    expect(guide).toContain("is not an inbound actor on this pad");
    expect(guide).toContain("ScopeError");
    expect(guide).toContain("`v`");
    expect(guide).toContain("`p`");
    expect(guide).toContain("`i`");
    expect(guide).toContain("`d`");
    expect(guide).toContain("@");
    expect(guide).not.toContain("\u00b7");
    expect(guide).not.toMatch(/\bVellum\b(?! Command)/);
  });
});
