//! runMutationBatch (src/cli/core/batch.ts): one object or an array of them,
//! each decoded and sent on its own, at most `concurrency` at a time, and one
//! answer for all of them.

use std::sync::{Mutex, PoisonError, mpsc};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::envelope::Answer;
use crate::error::{ErrorType, Failure, Result};
use crate::input;
use crate::wire::{self, Data, Request, Timeout};

/// DEFAULT_BATCH_CONCURRENCY (src/cli/core/constants.ts).
pub const DEFAULT_CONCURRENCY: i64 = 5;

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Succeeded,
    PartialFailure,
    Failed,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Row {
    Ok {
        index: usize,
        ok: bool,
        data: Data,
    },
    Err {
        index: usize,
        ok: bool,
        error: Failure,
    },
}

#[derive(Serialize)]
struct Summary {
    outcome: Outcome,
    total: usize,
    success_count: usize,
    error_count: usize,
    concurrency: i64,
    results: Vec<Row>,
}

/// Every item of `input` decoded as `R`, readied by `ready`, and sent.
pub fn run<R, F>(input: &str, concurrency: Option<i64>, timeout: Timeout, ready: F) -> Answer
where
    R: Request + DeserializeOwned + Send,
    F: Fn(R) -> R + Sync,
{
    run_with(input, concurrency, |item, index| {
        let item: R = serde_json::from_value(item)
            .map_err(|e| Failure::input(e.to_string(), format!("item[{index}]")))?;
        wire::call(&ready(item), timeout)
    })
}

/// Every item of `input` through `one`, at most `concurrency` at a time.
pub fn run_with<F>(input: &str, concurrency: Option<i64>, one: F) -> Answer
where
    F: Fn(Value, usize) -> Result<Data> + Sync,
{
    let concurrency = concurrency.unwrap_or(DEFAULT_CONCURRENCY);
    if concurrency <= 0 {
        return Err(
            Failure::input("concurrency must be a positive integer", "concurrency")
                .and("received", concurrency),
        );
    }
    let items = input::load_batch(input)?;
    let results = parallel(items, concurrency as usize, one);

    let total = results.len();
    let error_count = results.iter().filter(|r| r.is_err()).count();
    let success_count = total - error_count;
    let outcome = match (error_count, success_count) {
        (0, _) => Outcome::Succeeded,
        (_, 0) => Outcome::Failed,
        _ => Outcome::PartialFailure,
    };
    let retryable = results
        .iter()
        .all(|r| r.as_ref().err().is_some_and(Failure::retryable));
    let rows: Vec<Row> = results
        .into_iter()
        .enumerate()
        .map(|(index, result)| match result {
            Ok(data) => Row::Ok {
                index,
                ok: true,
                data,
            },
            Err(error) => Row::Err {
                index,
                ok: false,
                error,
            },
        })
        .collect();
    let summary = Summary {
        outcome,
        total,
        success_count,
        error_count,
        concurrency,
        results: rows,
    };

    // Nothing was written, so the envelope says ok:false: a caller reading .ok
    // never takes a refusal for a send. One item fails with its own error.
    if outcome == Outcome::Failed {
        if let [Row::Err { error, .. }] = summary.results.as_slice() {
            return Err(error.clone());
        }
        let mut details = serde_json::to_value(&summary).unwrap_or(Value::Null);
        if let Value::Object(map) = &mut details {
            // Retry the batch only when every item may be retried.
            map.insert("retryable".into(), retryable.into());
        }
        return Err(
            Failure::new(ErrorType::BatchFailed, format!("all {total} items failed")).with(details),
        );
    }
    crate::envelope::verdict(&summary, error_count > 0)
}

/// Each item through `one` on at most `workers` threads, answers in input order.
fn parallel<T: Send, U: Send>(
    items: Vec<T>,
    workers: usize,
    one: impl Fn(T, usize) -> U + Sync,
) -> Vec<U> {
    let total = items.len();
    let queue = Mutex::new(items.into_iter().enumerate());
    let (answered, answers) = mpsc::channel();
    std::thread::scope(|scope| {
        let (queue, one) = (&queue, &one);
        for _ in 0..workers.clamp(1, total.max(1)) {
            let answered = answered.clone();
            scope.spawn(move || {
                // A worker that panicked mid-item leaves the queue usable.
                while let Some((index, item)) =
                    queue.lock().unwrap_or_else(PoisonError::into_inner).next()
                {
                    let _ = answered.send((index, one(item, index)));
                }
            });
        }
    });
    drop(answered);
    let mut ordered: Vec<(usize, U)> = answers.into_iter().collect();
    ordered.sort_unstable_by_key(|(index, _)| *index);
    ordered.into_iter().map(|(_, answer)| answer).collect()
}
