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

### Phase 1 — Fork setup ✅ (this commit)
- Copy rc.6 → `mocha-slop`, `git init`, rename `package.json:name` to `mocha-bun`, add `bun` engine, `bin: {mocha, mocha-bun}`.

### Phase 2 — `node:fs.glob` migration (dep removal)
- **lookup-files.js**: replace `import * as glob from 'glob'` with `import fs from 'node:fs'`. Implement `hasMagic` helper (simple regex or `fs.glob` pattern check — Bun/Node don't expose hasMagic, so keep tiny helper). Replace `glob.sync` with `fs.globSync(pattern, {exclude: …?})` or `fs.globSync`. Audit `windowsPathsNoEscape`, `nodir`, sorting (`localeCompare('en')`). Keep behavior.
- **watch-run.cjs**: hardest. `glob.Glob` → replace with native `fs.globSync` expansion or keep `minimatch` path. Options: a) use `Bun.Glob` when on Bun (`new Bun.Glob(pattern).scanSync`), b) use `fs.globSync` listing + manual filter, c) vendor small pattern parser. Prefer (a)+(b) branching: if `fs.globSync` available use it, else fallback to lightweight regex. Remove `glob` import entirely.
- **package.json**: remove `glob` dep, update `knip`/`eslint` ignores, test with `node` and `bun`.
- Verify with `test/integration/glob.spec.cjs`, `test/unit` for lookup.

### Phase 3 — Bin / runtime detection
- Change shebang to `#!/usr/bin/env node` stays but add runtime detection inside:
  ```js
  const isBun = typeof Bun !== 'undefined' || !!process.versions.bun;
  const execPath = process.execPath; // already bun when run via bun
  ```
- Handle `isNodeFlag` when `process.allowedNodeEnvironmentFlags` missing/small: fallback list for Bun (`--conditions`, `--inspect`, etc), or treat unknown `--*` as Mocha unless in Bun allowlist.
- Ensure `spawn(execPath, args, {stdio:'inherit'})` works both: Bun's `spawn` supports same but `execArgv` forwarding differs (`Bun.spawn` vs `child_process.spawn`). Keep using `node:child_process.spawn` which Bun polyfills.
- Test: `bun ./bin/mocha.js --version`, `bun run mocha --help`, `node ./bin/mocha.js`.

### Phase 4 — Parallel (Bun-native option)
- **Option A (preferred per user)**: Bun-native pool. Use `Bun.Worker` or `node:worker_threads` with `Bun.Worker` interop, or `Bun.spawn` per file. Evaluate:
  - `workerpool` on Bun: test if `workerpool.pool(WORKER_PATH, {workerType:'process'})` works under `bun` (needs confirming). If not, replace pool impl when `isBun`.
  - Native Bun alternative: `lib/nodejs/buffered-worker-pool.bun.cjs` using `Bun.spawn([process.execPath, workerPath], {ipc: …})` or `new Worker(workerPath)` (ESM). Keep same `run(filepath, serializedOptions)` interface → `pool.run`.
  - `worker.cjs`: currently `workerpool.worker({run})`. For Bun, provide thin adapter: if `isBun`, use `process.on('message')` or `Bun.worker` message passing? Or keep `workerpool` but patch `forkOpts` to use `bun` exec.
- Keep fallback: Node path unchanged. Branch in `buffered-worker-pool.cjs`:
  ```js
  const isBun = !!process.versions.bun;
  if (isBun) { /* BunPool */ } else { /* existing workerpool */ }
  ```
- Also need `parallel-buffered-runner.cjs` interval `global.setInterval` → `globalThis.setInterval`.
- Validate: `bun ./bin/mocha.js --parallel test/smoke/*.spec.cjs` (also Node still passes).

### Phase 5 — Globals & runtime polyfills
- Replace bare `global` with `globalThis` in `lib/runner.cjs`, `lib/runnable.js`, `lib/reporters/*`, `lib/nodejs/*`. Keep `global` alias for compat: `const g = globalThis;`.
- Audit `process.features.require_module` check in `esm-utils.cjs` (Bun supports `.ts` natively). Ensure `requireOrImport` prefers `Bun` early return.
- Check `utils.cjs` etc for `global` enumeration: `Object.keys(globalThis)` + explicit allowlist.

### Phase 6 — Polish & verification
- `bun install` vs `npm install` scripts: `package.json` scripts currently `node bin/mocha.js`. Add `bun` variants or make them runtime agnostic (`--bun` flag). Update `README` for bun usage.
- Run full suites under both: `bun run test-node:unit`, `bun bin/mocha.js --parallel`.
- Remove `glob` from deps, ensure `minimatch` still needed? Maybe can also drop if using `fs.glob` but keep for `watch-run` `minimatch` filtering.

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
