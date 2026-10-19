import { describe, expect, it, vi } from "vitest";
import { answerLabel, feedAnswerForKey, sendSignalAnswer, type SignalAnswer } from "../src/renderer/lib/quick-replies";

const replies = ["Yes", "Looks good", "Go on"];
const notes = ["Acknowledged", "Good"];
const key = (key: string, code: string, shiftKey = false) => ({ key, code, shiftKey });

describe("feed keys: four answers on the selected item", () => {
  it("1..9 send the waking quick reply", () => {
    expect(feedAnswerForKey(key("2", "Digit2"), replies, notes)).toEqual({ kind: "reply", text: "Looks good" });
    expect(feedAnswerForKey(key("9", "Digit9"), replies, notes)).toBeNull();
  });

  it("Shift+1..9 send the quiet note, read off the physical key", () => {
    // Shift turns Digit1 into "!" on a US layout; the code still says 1.
    expect(feedAnswerForKey(key("!", "Digit1", true), replies, notes)).toEqual({ kind: "quiet", text: "Acknowledged" });
    expect(feedAnswerForKey(key("@", "Digit2", true), replies, notes)).toEqual({ kind: "quiet", text: "Good" });
    expect(feedAnswerForKey(key("#", "Digit3", true), replies, notes)).toBeNull();
    // Shift never falls through to a waking reply.
    expect(feedAnswerForKey(key("1", "Digit1", true), replies, [])).toBeNull();
  });

  it("a acknowledges and d dismisses; their capitals and other letters do nothing", () => {
    expect(feedAnswerForKey(key("a", "KeyA"), replies, notes)).toEqual({ kind: "acknowledge" });
    expect(feedAnswerForKey(key("d", "KeyD"), replies, notes)).toEqual({ kind: "dismiss" });
    expect(feedAnswerForKey(key("A", "KeyA", true), replies, notes)).toBeNull();
    expect(feedAnswerForKey(key("x", "KeyX"), replies, notes)).toBeNull();
  });

  it("labels a quiet note apart from a waking reply of the same words", () => {
    expect(answerLabel({ kind: "reply", text: "Good" })).not.toBe(answerLabel({ kind: "quiet", text: "Good" }));
  });
});

describe("sending each answer", () => {
  const actions = () => ({
    respond: vi.fn(async () => ({ ok: true as const })),
    dismiss: vi.fn(async () => ({ ok: true as const })),
  });
  const send = async (answer: SignalAnswer) => {
    const spies = actions();
    await sendSignalAnswer("sig-1", answer, spies);
    return spies;
  };

  it("dismiss: closes through dismiss, never answers", async () => {
    const { respond, dismiss } = await send({ kind: "dismiss" });
    expect(dismiss).toHaveBeenCalledWith("sig-1");
    expect(respond).not.toHaveBeenCalled();
  });

  it("acknowledge: an empty quiet answer, so main records it answered with no mail", async () => {
    const { respond, dismiss } = await send({ kind: "acknowledge" });
    expect(respond).toHaveBeenCalledWith("sig-1", "", { silent: true });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("quiet note: the note, silent", async () => {
    const { respond } = await send({ kind: "quiet", text: "Good" });
    expect(respond).toHaveBeenCalledWith("sig-1", "Good", { silent: true });
  });

  it("reply: the text with no silent option, so it mails and wakes the seat", async () => {
    const { respond } = await send({ kind: "reply", text: "Go on" });
    expect(respond).toHaveBeenCalledWith("sig-1", "Go on");
  });
});
