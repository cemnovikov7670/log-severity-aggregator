# log-severity-aggregator

Counts log records by severity level within a flush window and emits summary counters.

## Usage

```js
import { LogSeverityAggregator, SEVERITY_LEVELS } from 'log-severity-aggregator';

const agg = new LogSeverityAggregator({
  flushMs: 5000,
  now: () => Date.now(),
});

agg.record({ severity: 'info' });
agg.record({ severity: 'error' });
agg.record({ severity: 'silly' }); // not a canonical level

const summary = agg.maybeFlush(); // null until the window elapses
// or force a flush regardless of the clock:
const forced = agg.flush();
```

`SEVERITY_LEVELS` is the frozen canonical list: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. `isValidSeverity(severity)` returns a boolean.

## Summary shape

`summary()` and `flush()` both return:

```js
{
  windowStart: number,              // epoch ms at last flush (or construction)
  windowEnd: number,                // epoch ms at call time
  counts: Record<string, number>,  // every canonical level present, 0 if unseen
  total: number,                    // known + unknown
  unknown: number,                  // records whose severity was not canonical
}
```

`summary()` does not reset counters; `flush()` does.

## Why this exists

Log pipelines often need to answer "how many errors per minute?" without retaining the log lines themselves. The trade-off here is deliberately narrow: this library only counts severities and emits a snapshot. It does not format logs, route them, or attach metadata. Keeping the surface small means there is nothing to configure around transport, and nothing to break when the log shape changes.

## Edge cases worth knowing

- Severity matching is **case-sensitive**. `'INFO'` is counted as `unknown`, not `info`. Pick your casing upstream, or normalise before calling `record`.
- Unknown severities are **counted, not dropped**. They land in `unknown` and `total` but never in any canonical level's counter. This is so a typo in a log call does not silently erase evidence.
- `now` is a required constructor argument, not defaulted to `Date.now()`. The intent is to make time-injection impossible to forget; a missing clock fails loudly at construction rather than producing tests that pass locally and flake under load.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

## Limitations

Values are coerced to floats, so very large integers lose precision. If you need
exact integer aggregates over a window, this is the wrong tool.

