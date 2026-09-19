// The single source of truth for the version is package.json. The manifest serves VERSION,
// which is how you confirm that the process now answering is the build you just installed -
// the only check that catches a supervisor which failed to restart, since the old process
// keeps answering happily. A hand-maintained copy here could drift from package.json while
// its own test still passed - pinning the duplicate proves only that the duplicate is what
// it was - and the symptom would be that check failing against a perfectly healthy service.
// tsdown bundles the import, so this is resolved at build time
// and the shipped dist/server.mjs contains the literal, not a package.json read at runtime.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
