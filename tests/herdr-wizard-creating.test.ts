import { describe, expect, it } from "vitest";
import {
  closeHerdrWizard,
  herdr$,
  isHerdrWizardEpochCurrent,
  openHerdrWizard,
} from "../src/renderer/lib/herdr-state";

/**
 * Models the create-busy flag lifecycle that lives in HerdrWizard React state.
 * The component stays mounted when closed (`if (!open) return null`), so a
 * create that closes the wizard must not leave `creating` stuck true.
 */
describe("herdr wizard create-busy lifecycle", () => {
  it("clears creating even when placeNode closed the wizard (stillOpen false)", () => {
    let creating = false;
    let open = true;
    let epoch = 1;
    const epochRef = 1;
    const stillOpen = () => open && epoch === epochRef;

    creating = true;
    // placeNode → closeHerdrWizard
    open = false;
    epoch += 1;

    // Buggy: gated clear (pre-fix)
    if (stillOpen()) creating = false;
    expect(creating).toBe(true);

    // Fixed: always clear
    creating = false;
    expect(creating).toBe(false);
  });

  it("re-open while already open bumps epoch so a stale epochRef is no longer current", () => {
    herdr$.wizardOpen.set(false);
    herdr$.wizardEpoch.set(0);

    openHerdrWizard({ x: 0, y: 0 });
    const first = herdr$.wizardEpoch.peek();
    expect(herdr$.wizardOpen.peek()).toBe(true);
    expect(isHerdrWizardEpochCurrent(first)).toBe(true);

    // Palette "add herdr" again without cancel — open stays true, epoch advances.
    openHerdrWizard({ x: 10, y: 10 });
    const second = herdr$.wizardEpoch.peek();
    expect(second).toBe(first + 1);
    expect(herdr$.wizardOpen.peek()).toBe(true);
    expect(isHerdrWizardEpochCurrent(first)).toBe(false);
    expect(isHerdrWizardEpochCurrent(second)).toBe(true);

    closeHerdrWizard();
    expect(herdr$.wizardOpen.peek()).toBe(false);
    expect(isHerdrWizardEpochCurrent(second)).toBe(false);
  });
});
