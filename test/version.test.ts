import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { VERSION } from '../src/version';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: unknown };

// Read from disk, not imported: an `import pkg from '../package.json'` here would resolve
// through the same mechanism src/version.ts uses, so a broken derivation could satisfy
// both sides at once. Reading the bytes independently is what makes this an assertion
// about package.json rather than about the import.
test('VERSION is package.json version', () => {
  expect(VERSION).toBe(pkg.version);
});

// The pin the old test had (`toBe('2.0.0')`) proved only that a hand-maintained duplicate
// still equalled itself. What actually has to hold is that the string is usable as a
// version at all: an upgrade is confirmed by comparing the version the manifest reports to
// package.json's by exact string match, so an empty or undefined value breaks that check
// against a service that is running perfectly well.
test('VERSION is a non-empty version string', () => {
  expect(typeof VERSION).toBe('string');
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
