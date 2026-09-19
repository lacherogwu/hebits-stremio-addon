// The single source of truth for the version is package.json. scripts/deploy.sh reads the
// version from there (`node -p "require('./package.json').version"`) and then waits for the
// running service to report that same string back through the manifest, which serves
// VERSION. A hand-maintained copy here could drift from package.json while its own test
// still passed - pinning the duplicate proves only that the duplicate is what it was - and
// the first symptom would be every deploy failing after a 20-second wait against a
// perfectly healthy service. tsdown bundles the import, so this is resolved at build time
// and the shipped dist/server.mjs contains the literal, not a package.json read at runtime.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
