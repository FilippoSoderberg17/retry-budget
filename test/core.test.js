import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryBudget, RETRY_DENIED } from '../src/index.js';

// A controllable clock. We mutate .now between assertions so the tests are
// fully deterministic and never touch wall-clock time.
function fakeClock(start = 1000) {
  const state = { now: start };
  return {
    get now() {
      return state.now;
    },
    set now(v) {
      state.now = v;
    },
    advance(ms) {
      state.now += ms;
    },
  };
}

// Helper: build a budget with a fake clock wired in.
function makeBudget(opts = {}) {
  const clock = opts.clock ?? fakeClock(opts.start ?? 1000);
  const { clock: _unused, start, ...rest } = opts;
  return {
    clock,
    budget: new RetryBudget({
      maxTokens: 3,
      refillIntervalMs: 100,
      ...rest,
      clock: () => clock.now,
    }),
  };
}

// --- Construction & validation ---

test('starts full by default', () => {
  const { budget } = makeBudget({ maxTokens: 5, refillIntervalMs: 10 });
  assert.equal(budget.tokens, 5);
});

test('honours initialTokens', () => {
  const { budget } = makeBudget({
    maxTokens: 5,
    refillIntervalMs: 10,
    initialTokens: 2,
  });
  assert.equal(budget.tokens, 2);
});

test('rejects non-integer maxTokens', () => {
  assert.throws(
    () => new RetryBudget({ maxTokens: 2.5, refillIntervalMs: 10 }),
    /non-negative integer/
  );
});

test('rejects negative refillIntervalMs', () => {
  assert.throws(
    () => new RetryBudget({ maxTokens: 1, refillIntervalMs: -1 }),
    /non-negative integer/
  );
});

test('rejects initialTokens exceeding maxTokens', () => {
  assert.throws(
    () => new RetryBudget({
      maxTokens: 2,
      refillIntervalMs: 10,
      initialTokens: 3,
    }),
    /cannot exceed/
  );
});

// --- Token consumption & exhaustion ---

test('tryReserve consumes tokens until exhausted', () => {
  const { budget } = makeBudget({ maxTokens: 2, refillIntervalMs: 1000 });
  assert.equal(budget.tryReserve(), true);
  assert.equal(budget.tryReserve(), true);
  assert.equal(budget.tryReserve(), false);
  assert.equal(budget.tokens, 0);
});

test('totalAllowed and totalDenied accumulate correctly', () => {
  const { budget } = makeBudget({ maxTokens: 1, refillIntervalMs: 1000 });
  assert.equal(budget.tryReserve(), true);
  assert.equal(budget.tryReserve(), false);
  assert.equal(budget.tryReserve(), false);
  assert.equal(budget.totalAllowed, 1);
  assert.equal(budget.totalDenied, 2);
});

// --- Refill behaviour ---

test('refills one token per interval, capping at maxTokens', () => {
  const { clock, budget } = makeBudget({
    maxTokens: 2,
    refillIntervalMs: 100,
  });
  // Drain.
  assert.equal(budget.tryReserve(), true);
  assert.equal(budget.tryReserve(), true);
  assert.equal(budget.tokens, 0);

  clock.advance(99);
  assert.equal(budget.tokens, 0); // not yet

  clock.advance(1); // total elapsed 100
  assert.equal(budget.tokens, 1);

  clock.advance(100); // total elapsed 200 -> second token
  assert.equal(budget.tokens, 2); // capped

  clock.advance(1000); // way past, still capped
  assert.equal(budget.tokens, 2);
});

test('refill preserves partial progress toward the next token', () => {
  const { clock, budget } = makeBudget({
    maxTokens: 1,
    refillIntervalMs: 100,
  });
  assert.equal(budget.tryReserve(), true); // tokens -> 0
  assert.equal(budget.tokens, 0);

  clock.advance(150); // 1 full interval, 50ms toward next
  assert.equal(budget.tokens, 1);

  // Drain again so we can observe the leftover 50ms.
  assert.equal(budget.tryReserve(), true);
  assert.equal(budget.tokens, 0);

  clock.advance(50); // only 50ms more, but 50 was already banked -> 1 interval
  assert.equal(budget.tokens, 1);
});

test('zero refillIntervalMs disables time-based refill', () => {
  const { clock, budget } = makeBudget({
    maxTokens: 1,
    refillIntervalMs: 0,
  });
  assert.equal(budget.tryReserve(), true);
  clock.advance(99999);
  assert.equal(budget.tokens, 0);
});

// --- withRetry ---

test('withRetry runs fn when budget allows and returns its value', async () => {
  const { budget } = makeBudget({ maxTokens: 1, refillIntervalMs: 1000 });
  const result = await budget.withRetry(() => 'ok');
  assert.equal(result, 'ok');
  assert.equal(budget.tokens, 0);
});

test('withRetry returns RETRY_DENIED when exhausted', async () => {
  const { budget } = makeBudget({ maxTokens: 0, refillIntervalMs: 1000 });
  const result = await budget.withRetry(() => 'should-not-run');
  assert.equal(result, RETRY_DENIED);
  assert.equal(budget.totalDenied, 1);
});

test('withRetry does NOT conflate fn returning undefined with denial', async () => {
  const { budget } = makeBudget({ maxTokens: 1, refillIntervalMs: 1000 });
  const r = await budget.withRetry(() => undefined);
  assert.notEqual(r, RETRY_DENIED);
  assert.equal(r, undefined);
});

test('withRetry propagates fn rejections', async () => {
  const { budget } = makeBudget({ maxTokens: 1, refillIntervalMs: 1000 });
  await assert.rejects(
    budget.withRetry(() => Promise.reject(new Error('boom'))),
    /boom/
  );
  // Token was consumed before fn ran — that is the documented contract.
  assert.equal(budget.tokens, 0);
  assert.equal(budget.totalAllowed, 1);
});

test('withRetry rejects if fn is not a function', async () => {
  const { budget } = makeBudget({ maxTokens: 1, refillIntervalMs: 1000 });
  await assert.rejects(budget.withRetry('nope'), /function/);
});

// --- Close ---

test('close denies all subsequent reservations idempotently', () => {
  const { budget } = makeBudget({ maxTokens: 5, refillIntervalMs: 1000 });
  assert.equal(budget.closed, false);
  budget.close();
  assert.equal(budget.closed, true);
  assert.equal(budget.tryReserve(), false);
  assert.equal(budget.tryReserve(), false);
  assert.equal(budget.totalAllowed, 0);
  assert.equal(budget.totalDenied, 2);
  // Closing again is a no-op, not an error.
  budget.close();
  assert.equal(budget.closed, true);
});

test('withRetry on a closed budget returns RETRY_DENIED without running fn', async () => {
  const { budget } = makeBudget({ maxTokens: 5, refillIntervalMs: 1000 });
  budget.close();
  let ran = false;
  const r = await budget.withRetry(() => {
    ran = true;
    return 'x';
  });
  assert.equal(r, RETRY_DENIED);
  assert.equal(ran, false);
});

// --- Shared-budget semantics across two consumers ---

test('two consumers sharing one budget contend for the same tokens', () => {
  const { budget } = makeBudget({ maxTokens: 2, refillIntervalMs: 1000 });
  // Consumer A takes both.
  assert.equal(budget.tryReserve(), true);
  assert.equal(budget.tryReserve(), true);
  // Consumer B is now denied — this is the load-amplification protection.
  assert.equal(budget.tryReserve(), false);
});
