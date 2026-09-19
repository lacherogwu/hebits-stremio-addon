import { expect, test } from 'vitest';
import { makeLock } from '../src/lock';

// Collects process-level unhandledRejection events rather than trusting the test
// runner's own handling of them, per the trap this suite exists to catch: a second
// call on the same key attaches a .catch to the very promise that would otherwise
// leak, so only an UNCONTENDED failing call proves nothing is left dangling.
function captureUnhandledRejections() {
  const events: unknown[] = [];
  const onRejection = (reason: unknown) => events.push(reason);
  process.on('unhandledRejection', onRejection);
  return {
    events,
    async stop() {
      // unhandledRejection fires on a later microtask/macrotask turn than the
      // rejection itself, so give the event loop a full turn before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.off('unhandledRejection', onRejection);
    },
  };
}

test('serializes calls that share a key', async () => {
  const withLock = makeLock();
  const order: string[] = [];
  const first = withLock('k', async () => {
    order.push('first-start');
    await new Promise((r) => setTimeout(r, 20));
    order.push('first-end');
  });
  const second = withLock('k', async () => {
    order.push('second-start');
  });
  await Promise.all([first, second]);
  expect(order).toEqual(['first-start', 'first-end', 'second-start']);
});

test('does not serialize calls on different keys', async () => {
  const withLock = makeLock();
  const order: string[] = [];
  const a = withLock('a', async () => {
    order.push('a-start');
    await new Promise((r) => setTimeout(r, 20));
    order.push('a-end');
  });
  const b = withLock('b', async () => {
    order.push('b-start');
  });
  await Promise.all([a, b]);
  expect(order[0]).toBe('a-start');
  expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
});

test('a rejection reaches the caller', async () => {
  const withLock = makeLock();
  await expect(withLock('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
});

test('a rejecting call does not block the next call on the same key', async () => {
  const withLock = makeLock();
  await expect(withLock('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  await expect(withLock('k', () => 'ok')).resolves.toBe('ok');
});

test('a lone rejecting call on an uncontended key leaves no unhandled rejection', async () => {
  const capture = captureUnhandledRejections();
  const withLock = makeLock();
  await expect(withLock('solo-key', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  await capture.stop();
  expect(capture.events).toEqual([]);
});

test('a rejecting call on a contended key also leaves no unhandled rejection', async () => {
  const capture = captureUnhandledRejections();
  const withLock = makeLock();
  const first = withLock('k2', () => Promise.reject(new Error('boom')));
  const second = withLock('k2', () => 'ok');
  await expect(first).rejects.toThrow('boom');
  await expect(second).resolves.toBe('ok');
  await capture.stop();
  expect(capture.events).toEqual([]);
});
