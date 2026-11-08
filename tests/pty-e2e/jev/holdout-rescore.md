# Held-out re-score from the stored answers

No model calls: every number below is re-derived from the raw answers in
`.amp/in/artifacts/jev-pty-poc/compare-holdout-2026-09-17T06-29-03-623Z.json`
(sha256 `b35d4b9532a212b121e8a4d6926328eef855829329ac5e1634082ad55f20d726`, generated 2026-09-17T06:29:03.623Z, service model `jev-1.13.0`).

Policy: Noul two-sided at >= 0.9 and <= 0.1; Choice at confidence >= 0.8 and top probability >= 0.8.

Labels joined against the current manifest: 40 of 42 rows; 2 row(s) fell back to the labels frozen in the paid report: devin/mail-notice#869, kimi/type-echo#6795.

## Coverage and errors per question

| question | published | abstained | coverage | correct | wrong | accuracy | unfalsifiable | vacuous | label insufficient_evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| activity | 37 | 5 | 88.1% | 0 | 3 | 0% | 0 | 34 | 0 |
| turn_in_progress | 10 | 32 | 23.8% | 9 | 0 | 100% | 1 | 0 | 4 |
| approval_requested | 33 | 9 | 78.6% | 14 | 0 | 100% | 19 | 0 | 22 |
| answer_requested | 22 | 20 | 52.4% | 7 | 0 | 100% | 15 | 0 | 31 |
| access_problem | 35 | 7 | 83.3% | 21 | 0 | 100% | 14 | 0 | 15 |
| execution_error | 30 | 12 | 71.4% | 17 | 0 | 100% | 13 | 0 | 18 |
| repetition | 13 | 29 | 31% | 8 | 1 | 88.9% | 4 | 0 | 8 |
| highlight_exists | 15 | 27 | 35.7% | 15 | 0 | 100% | 0 | 0 | 6 |
| highlight_line | 16 | 26 | 38.1% | 11 | 0 | 100% | 5 | 0 | 15 |

`vacuous` is agreement on the pack's own no-signal option (`activity = indeterminate`,
`repetition = insufficient_evidence`): agreement on having nothing to say, not evidence
of classification. `unfalsifiable` is a published answer on a label the corpus cannot
ground. `coverage` is published / rows.

## turn_in_progress against the control plane

Compared 10 published rows (yes 1, no 9): 9 agreed, 1 disagreed, 0 published with no control state at that cut.

| checkpoint | control state | control reason | published | noul | agrees |
| --- | --- | --- | --- | --- | --- |
| claude/mail-notice#3916 | idle | rule:composer_draft_idle | no | 0.08 | yes |
| devin/mail-notice#4594 | idle | default_known_agent_idle_fallback | yes | 0.9 | NO |
| devin/startup-trust#789 | attention | rule:workspace_trust_prompt | no | 0.08 | yes |
| grok/permission-returns-idle#4400 | idle | rule:osc_title_idle | no | 0.1 | yes |
| hermes/type-echo#15892 | attention | rule:authentication_failed_attention | no | 0.07 | yes |
| hermes/type-echo#16216 | attention | rule:authentication_failed_attention | no | 0.07 | yes |
| hermes/type-echo#129731 | attention | rule:authentication_failed_attention | no | 0.08 | yes |
| hermes/type-echo#121947 | attention | rule:authentication_failed_attention | no | 0.09 | yes |
| kimi/type-echo#3417 | idle | default_known_agent_idle_fallback | no | 0.1 | yes |
| kimi/type-echo#7144 | attention | rule:model_not_configured_attention | no | 0.09 | yes |

## Bar sweep (Noul questions)

| question | positive bar | negative bar | published | correct | wrong | unfalsifiable | vacuous |
| --- | --- | --- | --- | --- | --- | --- | --- |
| turn_in_progress | 0.9 | 0.1 | 10 | 9 | 0 | 1 | 0 |
| turn_in_progress | 0.8 | 0.1 | 12 | 10 | 0 | 2 | 0 |
| turn_in_progress | 0.9 | 0.2 | 29 | 28 | 0 | 1 | 0 |
| turn_in_progress | 0.8 | 0.2 | 31 | 29 | 0 | 2 | 0 |
| turn_in_progress | 0.9 | 0.3 | 32 | 31 | 0 | 1 | 0 |
| turn_in_progress | 0.8 | 0.3 | 34 | 32 | 0 | 2 | 0 |
| turn_in_progress | 0.9 | 0.5 | 34 | 33 | 0 | 1 | 0 |
| turn_in_progress | 0.8 | 0.5 | 36 | 34 | 0 | 2 | 0 |
| approval_requested | 0.9 | 0.1 | 33 | 14 | 0 | 19 | 0 |
| approval_requested | 0.8 | 0.1 | 35 | 16 | 0 | 19 | 0 |
| approval_requested | 0.9 | 0.2 | 35 | 14 | 1 | 20 | 0 |
| approval_requested | 0.8 | 0.2 | 37 | 16 | 1 | 20 | 0 |
| approval_requested | 0.9 | 0.3 | 35 | 14 | 1 | 20 | 0 |
| approval_requested | 0.8 | 0.3 | 37 | 16 | 1 | 20 | 0 |
| approval_requested | 0.9 | 0.5 | 38 | 14 | 2 | 22 | 0 |
| approval_requested | 0.8 | 0.5 | 40 | 16 | 2 | 22 | 0 |
| answer_requested | 0.9 | 0.1 | 22 | 7 | 0 | 15 | 0 |
| answer_requested | 0.8 | 0.1 | 22 | 7 | 0 | 15 | 0 |
| answer_requested | 0.9 | 0.2 | 33 | 10 | 0 | 23 | 0 |
| answer_requested | 0.8 | 0.2 | 33 | 10 | 0 | 23 | 0 |
| answer_requested | 0.9 | 0.3 | 38 | 10 | 0 | 28 | 0 |
| answer_requested | 0.8 | 0.3 | 38 | 10 | 0 | 28 | 0 |
| answer_requested | 0.9 | 0.5 | 40 | 10 | 0 | 30 | 0 |
| answer_requested | 0.8 | 0.5 | 40 | 10 | 0 | 30 | 0 |
| access_problem | 0.9 | 0.1 | 35 | 21 | 0 | 14 | 0 |
| access_problem | 0.8 | 0.1 | 36 | 22 | 0 | 14 | 0 |
| access_problem | 0.9 | 0.2 | 37 | 22 | 0 | 15 | 0 |
| access_problem | 0.8 | 0.2 | 38 | 23 | 0 | 15 | 0 |
| access_problem | 0.9 | 0.3 | 37 | 22 | 0 | 15 | 0 |
| access_problem | 0.8 | 0.3 | 38 | 23 | 0 | 15 | 0 |
| access_problem | 0.9 | 0.5 | 38 | 22 | 1 | 15 | 0 |
| access_problem | 0.8 | 0.5 | 39 | 23 | 1 | 15 | 0 |
| execution_error | 0.9 | 0.1 | 30 | 17 | 0 | 13 | 0 |
| execution_error | 0.8 | 0.1 | 33 | 20 | 0 | 13 | 0 |
| execution_error | 0.9 | 0.2 | 35 | 18 | 0 | 17 | 0 |
| execution_error | 0.8 | 0.2 | 38 | 21 | 0 | 17 | 0 |
| execution_error | 0.9 | 0.3 | 35 | 18 | 0 | 17 | 0 |
| execution_error | 0.8 | 0.3 | 38 | 21 | 0 | 17 | 0 |
| execution_error | 0.9 | 0.5 | 37 | 20 | 0 | 17 | 0 |
| execution_error | 0.8 | 0.5 | 40 | 23 | 0 | 17 | 0 |
| highlight_exists | 0.9 | 0.1 | 15 | 15 | 0 | 0 | 0 |
| highlight_exists | 0.8 | 0.1 | 29 | 28 | 0 | 1 | 0 |
| highlight_exists | 0.9 | 0.2 | 15 | 15 | 0 | 0 | 0 |
| highlight_exists | 0.8 | 0.2 | 29 | 28 | 0 | 1 | 0 |
| highlight_exists | 0.9 | 0.3 | 15 | 15 | 0 | 0 | 0 |
| highlight_exists | 0.8 | 0.3 | 29 | 28 | 0 | 1 | 0 |
| highlight_exists | 0.9 | 0.5 | 16 | 16 | 0 | 0 | 0 |
| highlight_exists | 0.8 | 0.5 | 30 | 29 | 0 | 1 | 0 |

