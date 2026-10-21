import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STAMPS_REQUIRED_MAX } from "../src/shared/task-model";
import { StampDefaultControl } from "../src/renderer/components/tasks/StampDefaultControl";

const draw = (required: number) =>
  renderToStaticMarkup(<StampDefaultControl required={required} onChange={() => undefined} />);
const disabled = (html: string, label: string): boolean => {
  const tag = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? "";
  return tag.includes('disabled=""');
};

describe("StampDefaultControl", () => {
  it("reads zero plainly and stops going lower", () => {
    const html = draw(0);
    expect(html).toContain(">approvals<");
    expect(html).not.toContain("so none");
    expect(disabled(html, "Default one fewer approval")).toBe(true);
    expect(disabled(html, "Default one more approval")).toBe(false);
  });

  it("reads one as singular and stops at the wire maximum", () => {
    expect(draw(1)).toContain(">approval<");
    const html = draw(STAMPS_REQUIRED_MAX);
    expect(disabled(html, "Default one more approval")).toBe(true);
    expect(html).toContain(`>${STAMPS_REQUIRED_MAX}<`);
  });
});
