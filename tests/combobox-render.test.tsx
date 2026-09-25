/**
 * House typeahead markup: combobox + listbox roles wired by id, the value is
 * only what was typed (no ghost in it), and the highlight is carried by
 * aria-activedescendant rather than by the field.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Combobox } from "../src/renderer/components/ui";

const render = (props: Partial<Parameters<typeof Combobox<string>>[0]> = {}) =>
  renderToStaticMarkup(
    <Combobox<string>
      aria-label="Folder"
      listLabel="Folders in /Users/developer"
      value="/Users/developer/Pro"
      onValueChange={() => {}}
      completion="/Users/developer/Projects/"
      options={["Projects", "Pictures"]}
      optionKey={(name) => name}
      renderOption={(name) => name}
      activeKey={undefined}
      onActiveKeyChange={() => {}}
      onCommit={() => {}}
      {...props}
    />,
  );

describe("Combobox markup", () => {
  it("wires the field to its listbox", () => {
    const html = render();
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain('role="combobox"');
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}" role="listbox" aria-label="Folders in /Users/developer"`);
    expect(html.match(/role="option"/g)).toHaveLength(2);
  });

  it("keeps the value to what was typed", () => {
    const html = render();
    expect(html).toContain('value="/Users/developer/Pro"');
    expect(html).not.toContain("Projects/");
  });

  it("points at the highlighted option without touching the value", () => {
    const html = render({ activeKey: "Pictures" });
    const active = /aria-activedescendant="([^"]+)"/.exec(html)?.[1];
    expect(active).toBeTruthy();
    expect(html).toContain(`id="${active}" role="option" aria-selected="false"`);
    expect(html).toContain('value="/Users/developer/Pro"');
  });

  it("marks the option the value already names", () => {
    expect(render({ selectedKey: "Projects" })).toContain('role="option" aria-selected="true"');
  });

  it("shows the status in place of the list", () => {
    const html = render({ status: <div role="status">Reading</div> });
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain("aria-controls");
  });
});
