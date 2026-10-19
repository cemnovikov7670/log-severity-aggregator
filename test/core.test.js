import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogSeverityAggregator, SEVERITY_LEVELS, isValidSeverity } from '../src/index.js';

// A controllable fake clock. Tests must never depend on wall-clock time.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

test('isValidSeverity recognises canonical levels', () => {
  for (const level of SEVERITY_LEVELS) {
    assert.equal(isValidSeverity(level), true);
  }
});

test('isValidSeverity rejects non-strings and unknown levels', () => {
  assert.equal(isValidSeverity('silly'), false);
  assert.equal(isValidSeverity('INFO'), false); // case-sensitive on purpose
  assert.equal(isValidSeverity(''), false);
  assert.equal(isValidSeverity(undefined), false);
  assert.equal(isValidSeverity(null), false);
  assert.equal(isValidSeverity(123), false);
  assert.equal(isValidSeverity([]), false);
});

test('constructor rejects non-positive or non-finite flushMs', () => {
  const now = fakeClock();
  assert.throws(() => new LogSeverityAggregator({ flushMs: 0, now }), TypeError);
  assert.throws(() => new LogSeverityAggregator({ flushMs: -1, now }), TypeError);
  assert.throws(() => new LogSeverityAggregator({ flushMs: Infinity, now }), TypeError);
  assert.throws(() => new LogSeverityAggregator({ flushMs: NaN, now }), TypeError);
});

test('constructor requires a clock function', () => {
  assert.throws(() => new LogSeverityAggregator({ flushMs: 1000 }), TypeError);
  assert.throws(() => new LogSeverityAggregator({ flushMs: 1000, now: 'now' }), TypeError);
});

test('summary before any records has all severities at zero and total 0', () => {
  const clock = fakeClock(1000);
  const agg = new LogSeverityAggregator({ flushMs: 5000, now: clock.now });
  const s = agg.summary();
  assert.equal(s.total, 0);
  assert.equal(s.unknown, 0);
  assert.equal(s.windowStart, 1000);
  assert.equal(s.windowEnd, 1000);
  for (const level of SEVERITY_LEVELS) {
    assert.equal(s.counts[level], 0);
  }
});

test('record counts each severity and returns true for known severities', () => {
  const clock = fakeClock(0);
  const agg = new LogSeverityAggregator({ flushMs: 1000, now: clock.now });
  assert.equal(agg.record({ severity: 'info' }), true);
  assert.equal(agg.record({ severity: 'info' }), true);
  assert.equal(agg.record({ severity: 'warn' }), true);
  assert.equal(agg.record({ severity: 'error' }), true);
  assert.equal(agg.record({ severity: 'trace' }), true);
  assert.equal(agg.record({ severity: 'debug' }), true);
  assert.equal(agg.record({ severity: 'fatal' }), true);
  const s = agg.summary();
  assert.equal(s.counts.info, 2);
  assert.equal(s.counts.warn, 1);
  assert.equal(s.counts.error, 1);
  assert.equal(s.counts.trace, 1);
  assert.equal(s.counts.debug, 1);
  assert.equal(s.counts.fatal, 1);
  assert.equal(s.total, 7);
  assert.equal(s.unknown, 0);
});

test('record counts unknown severities under unknown and returns false', () => {
  const clock = fakeClock(0);
  const agg = new LogSeverityAggregator({ flushMs: 1000, now: clock.now });
  assert.equal(agg.record({ severity: 'silly' }), false);
  assert.equal(agg.record({ severity: 'INFO' }), false); // case mismatch
  assert.equal(agg.record({ message: 'no severity field' }), false);
  assert.equal(agg.record({}), false);
  const s = agg.summary();
  assert.equal(s.unknown, 4);
  assert.equal(s.total, 4);
  for (const level of SEVERITY_LEVELS) {
    assert.equal(s.counts[level], 0);
  }
});

test('summary does not reset counters', () => {
  const clock = fakeClock(0);
  const agg = new LogSeverityAggregator({ flushMs: 1000, now: clock.now });
  agg.record({ severity: 'info' });
  const first = agg.summary();
  const second = agg.summary();
  assert.deepEqual(second, first);
  assert.equal(second.counts.info, 1);
});

test('flush returns current summary and resets counters', () => {
  const clock = fakeClock(1000);
  const agg = new LogSeverityAggregator({ flushMs: 5000, now: clock.now });
  agg.record({ severity: 'info' });
  agg.record({ severity: 'warn' });
  agg.record({ severity: 'silly' });
  clock.advance(2000);
  const flushed = agg.flush();
  assert.equal(flushed.windowStart, 1000);
  assert.equal(flushed.windowEnd, 3000);
  assert.equal(flushed.counts.info, 1);
  assert.equal(flushed.counts.warn, 1);
  assert.equal(flushed.unknown, 1);
  assert.equal(flushed.total, 3);
  // after flush, the new window starts at the flush moment and counters are empty
  const s = agg.summary();
  assert.equal(s.windowStart, 3000);
  assert.equal(s.windowEnd, 3000);
  assert.equal(s.total, 0);
  assert.equal(s.unknown, 0);
  for (const level of SEVERITY_LEVELS) {
    assert.equal(s.counts[level], 0);
  }
});

test('flush is idempotent when nothing was recorded between flushes', () => {
  const clock = fakeClock(500);
  const agg = new LogSeverityAggregator({ flushMs: 100, now: clock.now });
  clock.advance(50);
  const first = agg.flush();
  assert.equal(first.total, 0);
  assert.equal(first.windowStart, 500);
  assert.equal(first.windowEnd, 550);
  const second = agg.flush();
  assert.equal(second.total, 0);
  assert.equal(second.windowStart, 550);
  assert.equal(second.windowEnd, 550);
});

test('maybeFlush returns null when window has not elapsed', () => {
  const clock = fakeClock(0);
  const agg = new LogSeverityAggregator({ flushMs: 1000, now: clock.now });
  agg.record({ severity: 'info' });
  clock.advance(500);
  assert.equal(agg.maybeFlush(), null);
  // counters untouched
  assert.equal(agg.summary().counts.info, 1);
});

test('maybeFlush flushes and returns summary when window has elapsed', () => {
  const clock = fakeClock(0);
  const agg = new LogSeverityAggregator({ flushMs: 1000, now: clock.now });
  agg.record({ severity: 'info' });
  clock.advance(1000);
  const flushed = agg.maybeFlush();
  assert.notEqual(flushed, null);
  assert.equal(flushed.counts.info, 1);
  assert.equal(flushed.windowStart, 0);
  assert.equal(flushed.windowEnd, 1000);
  // a second call immediately after does not flush (new window just started)
  assert.equal(agg.maybeFlush(), null);
});

test('counts accumulate correctly across records within one window', () => {
  const clock = fakeClock(0);
  const agg = new LogSeverityAggregator({ flushMs: 10000, now: clock.now });
  for (let i = 0; i < 100; i++) agg.record({ severity: 'info' });
  for (let i = 0; i < 50; i++) agg.record({ severity: 'error' });
  for (let i = 0; i < 5; i++) agg.record({ severity: 'fatal' });
  for (let i = 0; i < 3; i++) agg.record({ severity: 'bogus' });
  const s = agg.summary();
  assert.equal(s.counts.info, 100);
  assert.equal(s.counts.error, 50);
  assert.equal(s.counts.fatal, 5);
  assert.equal(s.unknown, 3);
  assert.equal(s.total, 158);
});

test('summary counts are a snapshot copy, not a live reference', () => {
  const clock = fakeClock(0);
  const agg = new LogSeverityAggregator({ flushMs: 1000, now: clock.now });
  agg.record({ severity: 'info' });
  const s = agg.summary();
  s.counts.info = 999;
  assert.equal(agg.summary().counts.info, 1);
});
