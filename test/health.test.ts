import { expect, test } from 'vitest';
import { createHealthTracker } from '../src/health';
import type { Notifier } from '../src/notify';

interface SentCall {
  kind: string;
  title: string;
  message: string;
  opts?: { force?: boolean };
}

function fakeNotifier(): Pick<Notifier, 'send' | 'reset'> & { sent: SentCall[]; resets: string[] } {
  const sent: SentCall[] = [];
  const resets: string[] = [];
  return {
    sent,
    resets,
    send: async (kind, title, message, opts) => {
      sent.push({ kind, title, message, opts });
      return true;
    },
    reset: (kind) => {
      resets.push(kind);
    },
  };
}

test('cold start: unknown -> ok updates health but sends no notification', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  expect(health.hebitsLogin).toBe('unknown');
  noteLogin(true);
  expect(health.hebitsLogin).toBe('ok');
  expect(notifier.sent).toEqual([]);
  expect(notifier.resets).toEqual([]);
});

test('ok -> failing sends a login alert', () => {
  const notifier = fakeNotifier();
  const logs: string[] = [];
  const { health, noteLogin } = createHealthTracker(notifier, (m) => logs.push(m));

  noteLogin(true); // reach 'ok' silently first
  noteLogin(false, 'Jackett search: HTTP 500');
  expect(health.hebitsLogin).toBe('failing');
  expect(health.error).toBe('Jackett search: HTTP 500');
  expect(notifier.sent.map((s) => s.kind)).toEqual(['login']);
});

test('failing -> ok sends login-ok and resets the login throttle', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  noteLogin(false, 'boom'); // reach 'failing' first
  noteLogin(true);
  expect(health.hebitsLogin).toBe('ok');
  expect(health.error).toBeNull();
  expect(notifier.resets).toEqual(['login']);
  expect(notifier.sent.map((s) => s.kind)).toEqual(['login', 'login-ok']);
});

test('a repeated success while already ok sends nothing', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  noteLogin(true); // unknown -> ok
  noteLogin(true); // ok -> ok, unchanged
  expect(health.hebitsLogin).toBe('ok');
  expect(notifier.sent).toEqual([]);
});

test('a repeated failure while already failing does not re-fire', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  noteLogin(false, 'boom');
  noteLogin(false, 'boom again');
  expect(health.hebitsLogin).toBe('failing');
  expect(notifier.sent.map((s) => s.kind)).toEqual(['login']);
});

// Pin: `login-ok` uses `force: true` so it fires immediately even though `noteLogin(false, ...)`
// above just recorded a send under a *different* kind's throttle window - this recovery alert
// must never wait out a quiet period.
test('the recovery alert is forced, bypassing any throttle', () => {
  const notifier = fakeNotifier();
  const { noteLogin } = createHealthTracker(notifier, () => {});

  noteLogin(false, 'boom');
  noteLogin(true);
  const recovery = notifier.sent.find((s) => s.kind === 'login-ok');
  expect(recovery?.opts?.force).toBe(true);
});
