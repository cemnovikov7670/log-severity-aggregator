/**
 * @file core.js — pure counter logic with no timers or I/O.
 *
 * A deliberate split from index.js keeps the counting logic trivially testable:
 * the caller injects both the clock function and the flush trigger, so no test
 * ever touches the real event loop. This avoids the classic "passes locally,
 * flakes in CI" sin for timer-driven code.
 */

/** Canonical severity levels the aggregator recognises, lowest to highest. */
export const SEVERITY_LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * Validate a severity string against the canonical set.
 *
 * Returning a boolean instead of throwing keeps the hot ingest path allocation-free
 * on the rejection case: callers can drop bad records without catching exceptions.
 *
 * @param {string} severity
 * @returns {boolean}
 */
export function isValidSeverity(severity) {
  if (typeof severity !== 'string') return false;
  for (let i = 0; i < SEVERITY_LEVELS.length; i++) {
    if (SEVERITY_LEVELS[i] === severity) return true;
  }
  return false;
}

/**
 * Create a fresh, empty counter record keyed by canonical severity.
 * Each severity is initialised to zero so that a never-seen level still appears
 * in summaries (dashboards expect a stable schema, not missing keys).
 *
 * @returns {Record<string, number>}
 */
function emptyCounts() {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const level of SEVERITY_LEVELS) {
    counts[level] = 0;
  }
  return counts;
}

/**
 * Aggregator that counts log records by severity level within a flush window
 * and emits a summary of the counts accumulated so far.
 */
export class LogSeverityAggregator {
  #counts = emptyCounts();
  #total = 0;
  #unknown = 0;
  #flushedAt;
  #flushMs;
  #now;

  /**
   * @param {object} options
   * @param {number} options.flushMs   Window length in milliseconds.
   * @param {() => number} options.now Clock function returning epoch ms.
   *                                  Required argument, never defaulted, so that
   *                                  accidental non-injection fails loudly.
   */
  constructor({ flushMs, now }) {
    if (!Number.isFinite(flushMs) || flushMs <= 0) {
      throw new TypeError('flushMs must be a positive finite number');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function returning epoch milliseconds');
    }
    this.#flushMs = flushMs;
    this.#now = now;
    this.#flushedAt = now();
  }

  /**
   * Record a log entry. Only its severity is inspected; the message and other
   * fields are ignored by design so the aggregator never retains large payloads.
   *
   * Unknown severities are tallied under `unknown` rather than rejected — a
   * log aggregator that silently drops records hides the exact data-loss bug
   * it was built to surface.
   *
   * @param {object} entry
   * @param {string} entry.severity
   * @returns {boolean} true if the severity was recognised, false if it counted as unknown
   */
  record({ severity } = {}) {
    if (isValidSeverity(severity)) {
      this.#counts[severity] += 1;
      this.#total += 1;
      return true;
    }
    this.#unknown += 1;
    this.#total += 1;
    return false;
  }

  /**
   * Summary of counts accumulated since the last flush. Does not reset the
   * window; call {@link flush} for that.
   *
   * @returns {{windowStart: number, windowEnd: number, counts: Record<string, number>, total: number, unknown: number}}
   */
  summary() {
    const windowEnd = this.#now();
    return {
      windowStart: this.#flushedAt,
      windowEnd,
      counts: { ...this.#counts },
      total: this.#total,
      unknown: this.#unknown,
    };
  }

  /**
   * Force a flush: return the current summary, then reset all counters and
   * advance the window start to the current clock value.
   *
   * @returns {{windowStart: number, windowEnd: number, counts: Record<string, number>, total: number, unknown: number}}
   */
  flush() {
    const windowEnd = this.#now();
    const result = {
      windowStart: this.#flushedAt,
      windowEnd,
      counts: { ...this.#counts },
      total: this.#total,
      unknown: this.#unknown,
    };
    this.#counts = emptyCounts();
    this.#total = 0;
    this.#unknown = 0;
    this.#flushedAt = windowEnd;
    return result;
  }

  /**
   * Convenience: flush only if the configured window has elapsed since the
   * last flush. Returns the summary on flush, or null when the window has not
   * yet elapsed. This lets a caller poll cheaply on every record without
   * inspecting timestamps itself.
   *
   * @returns {({windowStart: number, windowEnd: number, counts: Record<string, number>, total: number, unknown: number})|null}
   */
  maybeFlush() {
    if (this.#now() - this.#flushedAt < this.#flushMs) return null;
    return this.flush();
  }
}
