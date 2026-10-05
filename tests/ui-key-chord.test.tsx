import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Kbd, KeyChord } from "../src/renderer/components/ui";

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

describe("ui Kbd", () => {
  it("keeps its glance size by default and adds the list size on request", () => {
    expect(html(<Kbd>esc</Kbd>)).toBe('<kbd class="help-map__kbd">esc</kbd>');
    expect(html(<Kbd size="md">esc</Kbd>)).toContain("help-map__kbd--md");
  });
});

describe("ui KeyChord", () => {
  it("draws keys held together as caps side by side, with no plus sign", () => {
    const out = html(<KeyChord steps={[["⌘", "K"]]} />);
    expect(out.match(/<kbd/g)).toHaveLength(2);
    expect(out).not.toContain("+");
    expect(out).toContain('aria-label="⌘ K"');
  });

  it("joins steps pressed one after another with the word then", () => {
    const out = html(<KeyChord steps={[["G"], ["A"]]} />);
    expect(out).toContain(">then<");
    expect(out).toContain('aria-label="G, then A"');
  });

  it("takes a spoken label and passes the size to every cap", () => {
    const out = html(<KeyChord steps={[["⌘", "⇧", "P"]]} size="md" label="Command Shift P" />);
    expect(out).toContain('aria-label="Command Shift P"');
    expect(out.match(/help-map__kbd--md/g)).toHaveLength(3);
  });
});
