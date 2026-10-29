/**
 * A seat asks for a reply form (0.11/07, N4): --ask-secret, --ask-artifact
 * with --min-words and --label, --ask-proof, or the JSON form. One per
 * signal, blocked and escalate only, refused before anything is sent.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { notALabel } from "../src/shared/artifact-labels";
import { planFormFlags } from "../src/cli/core/signal-form";
import { loadSignalRaiseArgs as withSocket } from "../src/cli/core/signal-input";
import { WorkSocket } from "../src/cli/core/socket";

const load = (...args: Parameters<typeof withSocket>) =>
  Effect.runPromise(Effect.result(withSocket(...args).pipe(
    Effect.provideService(WorkSocket, WorkSocket.of({ call: () => Effect.die("no socket in this suite") })),
  )));

const refusedAt = (planned: ReturnType<typeof planFormFlags>) => (planned.ok ? undefined : planned.error.path);

describe("a seat asks for a reply form", () => {
  it("each flag asks for its form", () => {
    expect(planFormFlags("blocked", {})).toEqual({ ok: true, form: undefined });
    expect(planFormFlags("blocked", { askSecret: "CLOUDFLARE_API_TOKEN" })).toEqual({ ok: true, form: { kind: "secret", name: "CLOUDFLARE_API_TOKEN" } });
    expect(planFormFlags("escalate", { askProof: true })).toEqual({ ok: true, form: { kind: "proof" } });
    expect(planFormFlags("blocked", { askArtifact: "Shelf", minWords: 500, label: ["Posts", "daily", "posts"] })).toEqual({
      ok: true,
      form: { kind: "artifact", node: "Shelf", minWords: 500, labels: ["daily", "posts"] },
    });
  });

  it("refuses two forms, form flags on feedback, and artifact flags alone", () => {
    expect(refusedAt(planFormFlags("blocked", { askSecret: "A", askProof: true }))).toBe("--ask-proof");
    expect(refusedAt(planFormFlags("feedback", { askProof: true }))).toBe("--ask-proof");
    expect(refusedAt(planFormFlags("blocked", { minWords: 500 }))).toBe("--min-words");
    expect(refusedAt(planFormFlags("blocked", { label: ["x"] }))).toBe("--label");
    expect(refusedAt(planFormFlags("blocked", { askSecret: "A", minWords: 3 }))).toBe("--min-words");
    expect(refusedAt(planFormFlags("blocked", { askArtifact: "Shelf", minWords: 0 }))).toBe("--min-words");
    expect(refusedAt(planFormFlags("blocked", { askArtifact: "Shelf", label: ["ok", "a//b"] }))).toBe("--label[1]");
  });

  it("says the whole label rule, as artifact control and automations do", () => {
    const refused = planFormFlags("blocked", { askArtifact: "Shelf", label: ["/posts"] });
    expect(refused).toMatchObject({ ok: false, error: { message: notALabel("/posts") } });
    expect(notALabel("/posts")).toContain("no leading or trailing / or space, no //");
  });

  it("refuses a secret name that is not an environment variable", () => {
    for (const name of ["1TOKEN", "API-KEY", "my key", ""]) {
      expect(refusedAt(planFormFlags("blocked", { askSecret: name }))).toBe("--ask-secret");
    }
  });

  it("puts the form on the raise args, from flags or the JSON input, never both", async () => {
    const flags = await load("blocked", "Need the Cloudflare token.", undefined, {}, undefined, [], { askSecret: "CLOUDFLARE_API_TOKEN" });
    expect(flags).toMatchObject({ _tag: "Success", success: { kind: "blocked", text: "Need the Cloudflare token.", form: { kind: "secret", name: "CLOUDFLARE_API_TOKEN" } } });

    const json = await load("escalate", '{"text":"Write the post","form":{"kind":"artifact","node":"Shelf","labels":["Social"],"minWords":120}}', undefined);
    expect(json).toMatchObject({ _tag: "Success", success: { form: { kind: "artifact", node: "Shelf", labels: ["social"], minWords: 120 } } });

    const twice = await load("blocked", '{"text":"x","form":{"kind":"proof"}}', undefined, {}, undefined, [], { askProof: true });
    expect(twice).toMatchObject({ _tag: "Failure", failure: { path: "form" } });

    const onFeedback = await load("feedback", '{"text":"x","form":{"kind":"proof"}}', undefined);
    expect(onFeedback).toMatchObject({ _tag: "Failure", failure: { path: "form" } });

    const stray = await load("blocked", '{"text":"x","form":{"kind":"proof","links":[]}}', undefined);
    expect(stray).toMatchObject({ _tag: "Failure" });

    const plain = await load("blocked", "Need a decision.", undefined);
    expect(plain).toMatchObject({ _tag: "Success" });
    if (plain._tag === "Success") expect("form" in plain.success).toBe(false);
  });
});
