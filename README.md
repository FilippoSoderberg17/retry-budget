# Retry Budget

A shared token bucket that throttles retry attempts so a failing dependency cannot amplify load. Multiple callers of the same dependency draw from one budget; when it is empty, retries are denied until the bucket refills.

## Usage

```js
import { RetryBudget, RETRY_DENIED } from 'retry-budget';

const budget = new RetryBudget({
  maxTokens: 10,
  refillIntervalMs: 1000, // one token per second
  // optional: inject a fake clock for tests
  // clock: () => fakeNowMs,
});

async function callFlakyService(input) {
  const result = await budget.withRetry(() => doRealRequest(input));
  if (result === RETRY_DENIED) {
    // Budget exhausted — back off or fail fast.
    throw new Error('retry budget exhausted');
  }
  return result;
}

// Or reserve manually if you manage the call yourself:
if (budget.tryReserve()) {
  // ...attempt the request...
} else {
  // denied
}

// Hard-stop all retries (e.g. when the dependency is confirmed down):
budget.close();
```

Exported names: `RetryBudget` (class), `RETRY_DENIED` (sentinel object).

`RetryBudget` constructor options:

- `maxTokens` (integer >= 0) — bucket capacity.
- `refillIntervalMs` (integer >= 0) — add one token every this many ms. `0` disables time-based refill.
- `initialTokens` (optional integer, defaults to `maxTokens`, must be <= `maxTokens`).
- `clock` (optional `() => number`) — returns current time in ms. Inject a fake in tests; defaults to `Date.now`.

Instance members:

- `tokens` (getter) — current count after pending refill.
- `tryReserve()` — consume one token; returns `true`/`false`. Never throws on exhaustion.
- `withRetry(fn)` — async; reserves a token then calls `fn`. Returns `RETRY_DENIED` if the budget refused. Propagates `fn`'s rejection if `fn` ran.
- `close()` — deny all future reservations. Idempotent.
- `closed` (getter).
- `totalAllowed`, `totalDenied` (getters) — counters since construction.

## Why this exists

When a downstream service degrades, naive retry logic multiplies traffic: each caller retries independently, the dependency buckles further, latency rises, more callers time out, more retries fire. A retry budget puts a single ceiling on the retry rate across every consumer of that dependency.

The trade-off: this library only throttles *attempts*. It does not implement backoff, jitter, circuit-breaking heuristics, or failure classification. Those are real concerns but they belong to the caller — bundling them here would force one backoff policy on everyone. `close()` is the one escape hatch: when you *know* the dependency is down, close the budget and retries stop immediately rather than trickling.

## The awkward edge

`withRetry` consumes the token *before* calling `fn`. If `fn` then throws or rejects, the token is already spent and is not refunded. This is deliberate: we are throttling attempts, not successes, and refunding on failure would let a persistently-failing dependency burst past the budget. If you need stricter accounting, call `tryReserve()` yourself and only spend the token once your attempt has a result you accept.

`RETRY_DENIED` is a frozen sentinel object, not a thrown error, so callers can distinguish "denied by budget" from "fn ran and returned `undefined`" without a try/catch. Compare with `===`.
