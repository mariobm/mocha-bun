<p align="center">
  <img src="docs/src/components/mocha-logo.svg" alt="Mocha test framework logo"/>
</p>

<p align="center">☕️ Classic, reliable, trusted test framework for Node.js and the browser ☕️</p>

<div align="center">

<a href="https://www.npmjs.com/package/mocha"><img src="https://img.shields.io/npm/v/mocha.svg" alt="npm version 12.0.0-rc.6-9.6-9.3"></a> <!-- x-release-please-version -->
<a href="https://github.com/mochajs/mocha"><img src="https://img.shields.io/node/v/mocha.svg" alt="Node Version"></a>
[![GitHub Actions Build Status](https://github.com/mochajs/mocha/actions/workflows/mocha.yml/badge.svg)](https://github.com/mochajs/mocha/actions/workflows/mocha.yml)
<a href="https://codecov.io/gh/mochajs/mocha"><img src="https://codecov.io/gh/mochajs/mocha/branch/main/graph/badge.svg" alt="Codecov Coverage Status"></a>

</div>

<div align="center">

<a href="https://discord.gg/KeDn2uXhER"><img alt="Chat - Discord" src="https://img.shields.io/badge/Chat-Discord-5765F2.svg" /></a>
<a href="https://github.com/mochajs/mocha#sponsors"><img src="https://opencollective.com/mochajs/tiers/sponsors/badge.svg" alt="OpenCollective Sponsors"></a>
<a href="https://github.com/mochajs/mocha#backers"><img src="https://opencollective.com/mochajs/tiers/backers/badge.svg" alt="OpenCollective Backers"></a>
[![Collective Funds Guidelines v0.1](https://img.shields.io/badge/collective_funds_guidelines-v0.1-D8E8D4?style=flat&labelColor=3A6457)](https://github.com/collective-funds/guidelines)

</div>

## mocha-bun (Bun fork)

This is `mocha-bun` — a fork of `mocha@12.0.0-rc.6` with first-class **Bun 1.4+** support. **Documentation in this fork uses ASD-STE100 Simplified Technical English.**

- **Engines:** `node >=22.12.0` (ESM), `bun >=1.4.0`
- **Bin:** `mocha` (`#!/usr/bin/env node`) and `mocha-bun` (`#!/usr/bin/env bun`) — no manual `node_modules/.bin` edit needed. Use `bunx mocha`, `bun run mocha`, or `mocha-bun` (`bun ./bin/mocha-bun.js`) for Bun; `npx mocha` / `node ./bin/mocha.js` for Node.
- **`--parallel` on Bun:** native `BunForkPool` (`lib/nodejs/worker-bun.cjs` + `node:child_process.fork` queue, reuse, `MOCHA_WORKER_ID`) — `workerpool` is kept for Node only. Verified `bun --parallel` 69ms vs Node 113ms.
- **`glob` → `fs.globSync`:** `lib/cli/lookup-files.js` and `watch-run.cjs` now use built-in `node:fs.globSync` + `minimatch.braceExpand` (removed direct `glob` dep, transitive via `nyc` remains).
- **ESM:** CLI layer (`options.js`, `collect-files.js`, `node-flags.js`) is ESM, Bun's `require(esm)` unsupported is avoided via `errors.cjs` shims and `import` chain.
- **Globals:** `global` → `globalThis` fallback in `runner`, `runnable`, `reporters`, `mocha.cjs`.

Install (private fork):
```bash
bun install mocha-bun   # or from this repo: bun install
bun ./bin/mocha-bun.js --no-config test/smoke/smoke.spec.cjs
bun ./bin/mocha-bun.js --no-config --parallel test/**/*.spec.cjs
```
Test matrix: `npm run test-bun` (smoke+unit+integration on Bun), `npm run test-node` (Node), `npm run test-bun:parallel-smoke`.

## Links

- **[Documentation](https://mochajs.org)**
- **[Release Notes / History / Changes](https://github.com/mochajs/mocha/blob/main/CHANGELOG.md)**
- [Code of Conduct](https://github.com/mochajs/mocha/blob/main/.github/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/mochajs/mocha/blob/main/.github/CONTRIBUTING.md)
- [Development](https://github.com/mochajs/mocha/blob/main/.github/DEVELOPMENT.md)
- [Discord](https://discord.gg/KeDn2uXhER) (ask questions here!)
- [Issue Tracker](https://github.com/mochajs/mocha/issues)

## Backers

[Become a backer](https://opencollective.com/mochajs) and show your support to our open source project on [our site](https://mochajs.org/#backers).

<a href="https://opencollective.com/mochajs"><img alt="Mocha's backers on Open Collective" src="https://opencollective.com/mochajs/tiers/backers.svg?limit=30&button=false&avatarHeight=46&width=750"></a>

## Sponsors

Does your company use Mocha? Ask your manager or marketing team if your company would be interested in supporting our project.
Support will allow the maintainers to dedicate more time for maintenance and new features for everyone.
Also, your company's logo will show [on GitHub](https://github.com/mochajs/mocha#readme) and on [our site](https://mochajs.org#sponsors) - who doesn't want a little extra exposure?
[Here's the info](https://opencollective.com/mochajs).

[![MochaJS Sponsor](https://opencollective.com/mochajs/tiers/sponsors/0/avatar)](https://opencollective.com/mochajs/tiers/sponsors/0/website)
[![MochaJS Sponsor](https://opencollective.com/mochajs/tiers/sponsors/1/avatar)](https://opencollective.com/mochajs/tiers/sponsors/1/website)
[![MochaJS Sponsor](https://opencollective.com/mochajs/tiers/sponsors/2/avatar)](https://opencollective.com/mochajs/tiers/sponsors/2/website)
[![MochaJS Sponsor](https://opencollective.com/mochajs/tiers/sponsors/3/avatar)](https://opencollective.com/mochajs/tiers/sponsors/3/website)

## Development

You might want to know that:

- Mocha is one of the _most-depended-upon_ modules on npm (source: [libraries.io](https://libraries.io/search?order=desc&platforms=NPM&sort=dependents_count)), and
- Mocha is an _independent_ open-source project, maintained exclusively by volunteers.

You might want to help:

- New to contributing to Mocha? Check out this list of [good first issues](https://github.com/mochajs/mocha/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22)
- Mocha could use a hand with [these issues](https://github.com/mochajs/mocha/issues?q=is%3Aopen+is%3Aissue+label%3A%22status%3A+accepting+prs%22)
- The [maintainer's handbook](https://github.com/mochajs/mocha/blob/main/MAINTAINERS.md) explains how things get done

Finally, come [chat with the maintainers on Discord](https://discord.gg/KeDn2uXhER) if you want to help with:

- Triaging issues, answering questions
- Review, merging, and closing pull requests
- Other project-maintenance-y things

## License

Copyright 2011-2024 OpenJS Foundation and contributors. Licensed [MIT](https://github.com/mochajs/mocha/blob/main/LICENSE).
