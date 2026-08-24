# mocha-bun — Bun Support Plan (living doc, forked from v12.0.0-rc.6)

> Fork: `mocha-bun` = `mocha@12.0.0-rc.6` + Bun runtime support. Private repo in `mocha-slop`.

## 0) Goals (user asked)

- `mocha` installed in a project should run with **Bun** without editing `node_modules/mocha/bin/mocha.js` (shebang + `process.execPath` handling).
- `mocha --parallel` must work on Bun (currently broken).
- Fix **global** stuff (tests leak / `global` vs `globalThis`, `Runner.globalProps`, etc).
- Replace `glob@13` dep with built-in `node:fs.glob` / `node:fs.globSync` (Node ≥22, Bun ≥1.1).

## 1) Current state / Research snapshot

- **Bun 1.4.0** on this machine: `process.versions.bun=1.4.0`, `process.execPath=/Users/mario/.bun/bin/bun`, `allowedNodeEnvironmentFlags` = 32 items (vs 292 on Node 26). Supports `fs.glob`/`fs.globSync` (verified: `typeof fs.glob===function` in both runtimes, `fs.globSync('**/*.js')` works).
- **Node 26.7.0**: `fs.glob` present, `glob` package still works but redundant.
- **bin/mocha.js**: `#!/usr/bin/env node` + `spawn(process.execPath, [...nodeArgv, mochaPath, ...mochaArgs])` if any node flag present, else `main()` in-process. On Bun, `process.execPath` is correct (bun), but `process.allowedNodeEnvironmentFlags` detection fails → Node flags mis-classified as Mocha flags. Also `spawn` via `process.execPath` works on Bun but `fork` semantics differ.
- **Parallel**: `lib/nodejs/buffered-worker-pool.cjs` → `workerpool` (`workerType:process`, `forkOpts: {execArgv: process.execArgv}`, `WORKER_PATH=require.resolve('./worker.cjs')`). `worker.cjs` uses `workerpool.worker({run})` + `requireOrImport` + `serialize-javascript`. Bun's `child_process.fork` path not tested well with `workerpool`; suspect `workerpool.isMainThread` + `execArgv` propagation breaks on Bun.
- **Watch**: `lib/cli/watch-run.cjs` uses `new glob.Glob(pattern, {dot:true, magicalBraces:true})` to build `createPathFilter`/`createPathMatcher`. Heavily tied to `glob` internals (`pattern.pattern()`, `pattern.rest()`, `pattern.globString()`).
- **lookup-files**: `lib/cli/lookup-files.js` uses `glob.hasMagic` + `glob.sync(pattern, {nodir:true, windowsPathsNoEscape:true})`.
- **Globals**: `lib/runner.cjs` `globalProps()` enumerates `global` + `globals = [setTimeout,…]`, `checkGlobals`, `Runner.immediately = global.setImmediate`; `lib/runnable.js` captures `global.Date/setTimeout`; reporters read `global.innerHeight`. Bun defines `global === globalThis` (verified true) but some Bun globals differ (e.g., `Bun` present). Need `globalThis` everywhere.
- **Engines**: `package.json` `engines.node = ^20.19.0 || >=22.12.0`; need to add `bun`.

## 2) Plan phases

### Phase 1 — Fork setup ✅ Done
- Copy rc.6 → `mocha-slop`, `git init`, rename `package.json:name` to `mocha-bun`, engines `node >=22.12.0`, `bun >=1.4.0`, bin `mocha` + `mocha-bun` (ESM decision: Node >22 assumed).

### Phase 2 — `node:fs.glob` migration ✅ Done (c15fcb1 + follow-ups)
- `lookup-files.js`: replaced `glob.sync`/`hasMagic` with `fs.globSync` + custom `hasMagic` regex, `nodir` filter, `en` sort; verified both runtimes (Node 26, Bun 1.4) via `lookupFiles` tests.
- `watch-run.cjs`: removed `glob.Glob`, replaced `createPathFilter` with `minimatch.braceExpand` + `isGlobSegment` split logic (handles `**`, `*`, `{a,b}`, `+(a|b)`), kept `minimatch` for `matchPattern`. Verified vs old `glob.Glob` output.
- `package.json`: removed direct `glob` dep (transitive via `nyc` remains), `bun install` 0.15s.

### Phase 3 — Bin / runtime detection + ESM migration ✅ Done
- Decision: go ESM (Node >=22 assumed). Created `lib/cli/options.js`, `collect-files.js`, `node-flags.js` as ESM alongside `.cjs` shims; `lib/cli/cli.js` now `import {loadOptions} from "./options.js"`, `parse-args.js` → `node-flags.js`. This fixes Bun's `require(esm)` unsupported (CJS→ESM) — `bun ./bin/mocha.js --help` now works (was `require() async module` error).
- `bin/mocha.js` updated to import from `options.js`/`node-flags.js` (ESM→ESM). Kept `#!/usr/bin/env node` but added `bin/mocha-bun.js` with `#!/usr/bin/env bun` and `package.json` bin `mocha-bun: ./bin/mocha-bun.js` so no manual edit needed (`bunx mocha-bun`, `bun ./bin/mocha-bun.js`).
- `isBun` detection via `process.versions.bun`/`globalThis.Bun` kept for `node-flags.js` (Bun has 32 flags vs Node 292) and `spawn(process.execPath)` correctly uses `bun` when run via Bun.

### Phase 4 — Parallel (Bun-native) ✅ Done (BunForkPool)
- Tested `workerpool` on Bun: hangs (1/1 busy, no completion after 5s) for both `process` and `thread`. Raw `fork` IPC works (ping/pong test). So built Bun-native pool.
- Added `lib/nodejs/worker-bun.cjs` (mirrors `worker.cjs` `run()` but uses `process.on('message', {cmd:'run',id,filepath,serializedOptions})` / `process.send({id,result})` instead of `workerpool.worker`).
- Added `BunForkPool` inside `lib/nodejs/buffered-worker-pool.cjs`: fork-per-worker with `node:child_process.fork(WORKER_BUN_PATH)`, queue, reuse, `MOCHA_WORKER_ID` env, `maxWorkers`, `stats()`, `terminate(force)` with graceful `send({cmd:'exit'})` → `SIGTERM` → `SIGKILL`. `isBun` branch uses `BunForkPool`, Node keeps `workerpool.pool(WORKER_PATH)`.
- Verified: `bun ./bin/mocha.js --no-config --parallel test/smoke/smoke.spec.cjs` 69ms (Node 113ms) with correct events; Node parallel still 134ms.

### Phase 5 — Globals & runtime polyfills ✅ Done
- Replaced bare `global` with `globalThis` (with `typeof globalThis !== 'undefined' ? globalThis : global` fallback) in: `lib/runner.cjs` (`Runner.immediately`, `globalProps`, `filterLeaks` `global.navigator`), `lib/runnable.js` (`global.Date`/`setTimeout`), `lib/reporters/html.js`/`xunit.js`/`base.js` (`global.Date`/`innerHeight`), `lib/mocha.cjs` (`global` passed to `EVENT_FILE_PRE_REQUIRE`), `lib/nodejs/parallel-buffered-runner.cjs`/`worker.cjs`/`worker-bun.cjs` (`global.setInterval`). Keeps compat but Bun's `global === globalThis` (true) now explicit.
- Added `lib/errors.cjs`/`error-constants.cjs` + fallback `try{require("./errors.cjs")}catch{require("./errors.js")}` in all CJS that did `require("../errors.js")` (config, options, run, run-helpers, mocha, worker, esm-utils, runner, buffered-worker-pool) to fix Bun's sync `require(esm)` after ESM migration (config → errors edge).

### Phase 6 — Polish & verification (next)
- Scripts: `package.json` still `node bin/mocha.js` for tests; add `bun` variants or runtime-agnostic (`--bun`). Update `README` for `mocha-bun` usage (`bun install mocha-bun`, `mocha` vs `mocha-bun` bin, `bun --parallel`).
- Full matrix: `node` + `bun` for `test/smoke`, `test/unit`, `test/node-unit`, `test/integration` (parallel). `glob` already removed from direct deps.
- Remaining: `esm-utils.cjs` Bun `.ts` handling, `bin` docs, `watch` mode chokidar on Bun, final lint.


## 3) Risk notes / Steering
- `fs.globSync` API slightly different: takes `pattern` string, not array; `exclude` option vs `nodir`. Need to test Bun's implementation parity (Bun's fs.globSync signature may differ from Node's). Check Node docs: `fs.globSync(pattern, options)` returns `string[]`.
- `watch-run` `createPathFilter` relies on `glob` pattern decomposition (`pattern()` / `rest()`). Replacing requires building equivalent dir/match sets without `glob`. Could keep `minimatch` for matching but dir discovery via `fs.globSync`.
- Parallel Bun pool may need to handle `serialize-javascript` + `eval` still (security ok for IPC). Keep.
- If `workerpool` works on Bun after patching `forkOpts.env.MOCHA_WORKER_ID`, maybe no native rewrite needed — test first before writing native pool.

## 4) Next steps (todo order)
- [ ] Commit Phase 1
- [ ] Phase 2: lookup-files.js → fs.globSync
- [ ] Phase 2: watch-run.cjs → remove glob.Glob
- [ ] Remove `glob` dep, bump?
- [ ] Phase 3: bin/mocha.js Bun detection
- [ ] Phase 4: parallel Bun pool
- [ ] Phase 5: global → globalThis
- [ ] Full `bun` + `node` matrix test

---
Updated: 2026-... living doc.
