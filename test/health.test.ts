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
  noteLogin(false, 'hebits search: HTTP 500');
  expect(health.hebitsLogin).toBe('failing');
  expect(health.error).toBe('hebits search: HTTP 500');
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

// The alert body is the owner's only signal that the addon has gone blind, and it has been
// rewritten twice. Pin what must hold: it fires on the transition, it names a recovery that
// exists (/cookie - the page that installs the cookie; there is no other way to install
// one), it carries the underlying error, and it never embeds a credential. It must also not
// assert the cookie expired: noteLogin(false) is called for ANY search failure, so the text
// says searches are failing and offers /cookie as the likely fix.
test('the login alert names /cookie, carries the error, and leaks no credential', () => {
  const notifier = fakeNotifier();
  const { noteLogin } = createHealthTracker(notifier, () => {});

  noteLogin(true); // reach 'ok' silently so the next call is a real transition
  noteLogin(false, 'Hebits search: HTTP 502');

  expect(notifier.sent).toHaveLength(1);
  const alert = notifier.sent[0];
  expect(alert?.kind).toBe('login'); // persisted throttle key - renaming it resets the throttle
  expect(alert?.message).toContain('/cookie');
  expect(alert?.message).toContain('HTTP 502');

  // Nothing cookie-shaped may appear. health.ts never receives the cookie, and this is what
  // stops a later "include the cookie so we can debug it" from shipping.
  const text = `${alert?.title} ${alert?.message}`;
  expect(text).not.toMatch(/PHPSESSID|session=/i);

  // It must not claim the login expired - it only knows the search failed.
  expect(alert?.title).toBe('Hebits searches are failing');
});
