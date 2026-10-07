import type { ReactNode } from "react";
import { CodeBlock, DiffView, Eyebrow } from "../ui";

/**
 * Dev gallery for code and diffs: every face of the shared component, for
 * judging by eye in both themes. Route: `#/gallery/code`. The texts are what
 * an agent might send with a needs-you card; none of it comes from git.
 */
const BEFORE = `export const parse = (text: string) => {
  const parts = text.split(",");
  return parts;
};
`;

const AFTER = `export const parse = (text: string) => {
  const parts = text.split(",").map((part) => part.trim());
  const kept = parts.filter(Boolean);
  return kept;
};
`;

const PATCH = `diff --git a/src/retry.py b/src/retry.py
--- a/src/retry.py
+++ b/src/retry.py
@@ -1,7 +1,9 @@
 import time
 
-def retry(call, times=3):
+def retry(call, times=3, wait=0.5):
     for attempt in range(times):
         try:
             return call()
         except IOError:
-            time.sleep(1)
+            time.sleep(wait * (2 ** attempt))
+    raise TimeoutError("gave up after %d tries" % times)
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Retry
 Calls a function again when it fails.
+Each wait is twice the one before.
`;

/** A diff an agent typed by hand: no git header at all. */
const BARE = `--- before
+++ after
@@ -1,3 +1,3 @@
 timeout: 30
-retries: 3
+retries: 5
 region: eu
`;

const RUST = `use std::collections::HashMap;

/// Counts each word once per line it appears on.
fn count(lines: &[&str]) -> HashMap<String, usize> {
    let mut seen = HashMap::new();
    for line in lines {
        for word in line.split_whitespace() {
            *seen.entry(word.to_lowercase()).or_insert(0) += 1;
        }
    }
    seen
}
`;

const LOG = `12:04:11 connect eu-1 ok
12:04:12 connect eu-2 refused
12:04:14 retry eu-2 ok
`;

function Sample({ title, note, children }: { readonly title: string; readonly note: string; readonly children: ReactNode }) {
  return (
    <section data-testid="code-sample" className="grid gap-2">
      <Eyebrow>{title}</Eyebrow>
      <p className="m-0 font-mono text-body text-dim">{note}</p>
      <div className="overflow-hidden rounded-md border border-stroke bg-ground">{children}</div>
    </section>
  );
}

export function CodeViewGallery() {
  return (
    <main className="h-screen overflow-auto bg-ground px-8 py-6 text-ink">
      <h1 className="m-0 font-mono text-title font-semibold">Code and diffs</h1>
      <div className="mt-6 grid max-w-[1100px] gap-8">
        <Sample title="Diff, from unified diff text" note="Two files, side by side.">
          <DiffView patch={PATCH} />
        </Sample>
        <Sample title="Diff, stacked" note="The same text in one column, for a narrow card.">
          <DiffView patch={PATCH} layout="unified" />
        </Sample>
        <Sample title="Diff, from a before and an after" note="Two texts and a file name; the diff is worked out here.">
          <DiffView before={BEFORE} after={AFTER} name="parser.ts" />
        </Sample>
        <Sample title="Diff typed by hand" note="No git header, no file name.">
          <DiffView patch={BARE} layout="unified" />
        </Sample>
        <Sample title="Code block, with a file name" note="The language is read from the name.">
          <CodeBlock text={RUST} name="count.rs" />
        </Sample>
        <Sample title="Code block, with a language only" note="No header.">
          <CodeBlock text={AFTER} language="typescript" />
        </Sample>
        <Sample title="Plain text" note="No language, no line numbers.">
          <CodeBlock text={LOG} lineNumbers={false} />
        </Sample>
        <Sample title="A language nobody knows" note="Shown as it is.">
          <CodeBlock text={LOG} language="not-a-language" />
        </Sample>
      </div>
    </main>
  );
}
