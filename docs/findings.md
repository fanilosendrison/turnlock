---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "markdown-codebase-findings"
workspace: "turnlock"
date: "2026-07-21"
step_id: 1
---

# Turnlock Codebase Findings

## 1. Review Basis

This report records the remaining findings from the hostile codebase review performed against commit `ca135ff`.

The current code is authoritative. The immutable NIBs are historical implementation briefs and were not used to classify code differences as defects.

The review covered all production source files, package and compiler configuration, the active test suite, build output, and targeted runtime probes. No production source file was modified during the review.

### Severity Model

- **Critical:** Breaks a core runtime guarantee and can corrupt, replay, strand, or concurrently execute a run.
- **High:** Breaks a documented runtime or distribution contract under accepted inputs.
- **Medium:** Produces misleading verification or an incorrect edge-case behavior without immediately corrupting a nominal run.

## 2. Executive Summary

| Finding ID | Severity | Summary |
| ---------- | -------- | ------- |
| TL-F-001 | Critical | Expired-lock takeover is not mutually exclusive |
| TL-F-002 | Critical | Initial mode can overwrite an existing run and replay stale results |
| TL-F-003 | Critical | Protocol output can be truncated before a successful process exit |
| TL-F-004 | High | Post-acquisition failures can leak the run lock |
| TL-F-005 | High | The first phase can observe state different from the authoritative snapshot |
| TL-F-006 | High | Batch job identifiers can escape or collide in the result directory |
| TL-F-007 | High | Protocol string serialization is not round-trip safe |
| TL-F-008 | High | The built package is not executable under the advertised Node runtime |
| TL-F-009 | High | The test suite overstates property and concurrency coverage |

The codebase is not ready to claim durable single-writer execution until TL-F-001 through TL-F-005 are resolved and covered by process-level regression tests.

## 3. Detailed Findings

### TL-F-001 — Expired-Lock Takeover Is Not Mutually Exclusive

- **Severity:** Critical
- **Confidence:** Confirmed by process-level reproduction
- **Resolution class:** Decisional

#### Affected Code

- `src/services/lock.ts:23-26`
- `src/services/lock.ts:47-91`
- `src/services/lock.ts:106-127`
- `src/services/lock.ts:138-158`
- `tests/lock/lock.test.ts:394-410`

#### Observation

Fresh acquisition uses `fs.openSync(lockPath, "wx")`, which provides exclusive creation while the path is absent. Expired-lock takeover does not preserve that guarantee:

1. Each contender fails the initial `O_EXCL` create because the expired lock exists.
2. Each contender can read the same expired owner record.
3. Each contender writes to the shared `<lockPath>.tmp` path.
4. Each contender can rename a replacement and return a successful `LockHandle`.

The ownership checks in `refreshLock()` and `releaseLock()` are also read-then-act sequences. The path can change after the token check and before `renameSync()` or `unlinkSync()`.

#### Reproduction Evidence

A barrier-synchronized probe launched 24 processes against one expired lock. The existing lock used a deliberately oversized but structurally accepted `ownerToken` to widen the race window.

Result:

```text
successes=7
failures=17
```

Seven processes returned successful lock handles for the same run.

The current `P-LK-c` test does not exercise process concurrency. It acquires once, then performs nine synchronous calls in a loop after the first acquisition has completed.

#### Impact

- Multiple phases can execute concurrently for the same run.
- Multiple writers can race on `state.json`, manifests, and `events.ndjson`.
- A stale owner can overwrite a successor during refresh.
- A stale owner can unlink a successor's lock during release.
- The runtime's single-writer guarantee no longer holds during crash recovery, which is the exact path where the lease mechanism is needed.

#### Recommended Correction

Choose and document a genuinely race-safe lock strategy for stale takeover. The design must make ownership acquisition, refresh, and release atomic with respect to owner identity; a shared temporary filename plus token pre-check is insufficient.

Add process-level tests covering:

- simultaneous acquisition of an absent lock;
- simultaneous takeover of an expired lock;
- refresh racing with takeover;
- release racing with takeover;
- corrupted or partially written lock records.

The acceptance condition is exactly one successful owner in every scenario.

### TL-F-002 — Initial Mode Can Overwrite an Existing Run and Replay Stale Results

- **Severity:** Critical
- **Confidence:** Confirmed by end-to-end reproduction
- **Resolution class:** Mechanical

#### Affected Code

- `src/engine/run-orchestrator.ts:34-47`
- `src/engine/run-orchestrator.ts:89-103`

#### Observation

Initial mode accepts an externally supplied `runId`, recursively creates the run directory, and writes a new initial `state.json` without checking whether the run already exists.

A normally yielded run has released its lock. A second invocation using the same `runId` but omitting `--resume` therefore acquires a new lock and resets the state to attempt zero. Existing manifests and result files remain in place.

#### Reproduction Evidence

The following sequence was executed:

1. Start a run with a fixed `runId`; it emits delegation `work`, attempt zero.
2. Write `results/work-0.json` with a result from that first invocation.
3. Start initial mode again with the same `runId`.
4. Resume the second initialization.

Observed terminal output:

```json
{
  "generation": 1,
  "token": "STALE-FIRST-ATTEMPT"
}
```

The event log contained two `orchestrator_start` events for the same run. The second initialization consumed the stale result produced for the first initialization.

#### Impact

- Durable state can be silently reset.
- Results from a previous logical run can be replayed into a new execution.
- Attempt isolation is bypassed because both initializations use attempt zero.
- The audit trail contains two starts but no explicit reset or adoption decision.

#### Recommended Correction

Before creating initial state, fail closed if the target run directory already contains `state.json` or other canonical run artifacts. The error must not alter existing files.

Add an end-to-end regression test that performs the exact initial-initial-resume sequence and verifies:

- the second initial invocation exits non-zero;
- the original snapshot and artifacts remain byte-identical;
- no second `orchestrator_start` is appended;
- stale results cannot be adopted.

### TL-F-003 — Protocol Output Can Be Truncated Before a Successful Process Exit

- **Severity:** Critical
- **Confidence:** Confirmed by process-level reproduction
- **Resolution class:** Mechanical

#### Affected Code

- `src/engine/delegate-handler.ts:165`
- `src/engine/delegation-reemit.ts:110`
- `src/engine/error-emitter.ts:31,50,63,76`
- `src/engine/signal-handlers.ts:45`
- `src/engine/terminal-handlers.ts:64,144,204`
- `src/engine/context.ts:43-47`

#### Observation

Every terminal path calls `process.stdout.write(block)` and then reaches `process.exit(code)` without checking the write result or waiting for the stream to drain.

When stdout is a pipe, writes can be asynchronous. `process.exit()` can terminate the process before buffered bytes reach the parent.

#### Reproduction Evidence

A delegation used a 20,000,000-character `resumeCommand`. The parent captured stdout through a pipe.

Observed result:

```text
exit=0
stdout_bytes=65536
has_end=false
```

The child reported success, but the parent received only 65,536 bytes and no `@@END@@` delimiter.

#### Impact

- The parent cannot parse the protocol block.
- The child exits successfully, so ordinary exit-code handling does not detect the failed handoff.
- The run is stranded after state persistence and lock release.
- Any unbounded protocol field can trigger the failure under sufficient pipe backpressure.

#### Recommended Correction

Centralize protocol emission in one service that guarantees completion before process termination. Viable approaches include a synchronous write to stdout's file descriptor or an awaited stream write that handles `drain` and errors.

Also define explicit maximum lengths for every protocol field, especially `resumeCmd` and error messages. Add process-level tests with payloads larger than the pipe buffer and a deliberately slow reader.

### TL-F-004 — Post-Acquisition Failures Can Leak the Run Lock

- **Severity:** High
- **Confidence:** Confirmed by end-to-end reproduction
- **Resolution class:** Mechanical

#### Affected Code

- `src/engine/run-orchestrator.ts:50-132`
- `src/engine/run-orchestrator.ts:175-204`
- `src/engine/run-orchestrator.ts:208-226`
- `src/engine/error-emitter.ts:34-78`

#### Observation

The lock handle is local to `runInitialMode()` or `runResumeMode()`. Errors that escape those functions reach the top-level catch, whose error emitter has no lock handle and cannot release ownership.

Potential post-acquisition throw sites include initial-state validation, state persistence, manifest operations, `resumeCommand()`, protocol construction, and unexpected resume errors.

#### Reproduction Evidence

An initial run used a `stateSchema` that rejected `initialState` after lock acquisition.

Observed result:

```text
exit=1
lock_exists=yes
```

A valid ERROR block was emitted, but `.lock` remained with a 30-minute lease.

#### Impact

- An immediately failed run cannot be retried until lease expiry or manual intervention.
- The runtime emits a terminal error while retaining an active-owner artifact.
- Repeated failures can leave many apparently active runs.
- The invariant that managed exits release the lock is not upheld.

#### Recommended Correction

Move lock ownership into a lifecycle object available to every terminal path. Centralize terminal emission, lock release, and exit so they execute in a defined order exactly once.

Do not rely solely on `finally` if terminal paths continue to call `process.exit()` directly, because forced exit bypasses normal asynchronous cleanup expectations.

Add fault-injection tests for every operation after acquisition and assert that `.lock` is absent after all managed ERROR exits.

### TL-F-005 — The First Phase Can Observe State Different from the Authoritative Snapshot

- **Severity:** High
- **Confidence:** Confirmed by end-to-end reproduction
- **Resolution class:** Decisional

#### Affected Code

- `src/engine/run-orchestrator.ts:89-103`
- `src/engine/run-orchestrator.ts:132`
- `src/engine/dispatch-loop.ts:63-65`
- `src/services/state-io.ts:152-172`

#### Observation

Initial mode writes `config.initialState` to `state.json`, then dispatches the in-memory `initialState` object instead of the canonical JSON representation that was persisted.

`JSON.stringify()` can transform or discard values. The subsequent `structuredClone()` preserves several values differently from JSON serialization. The first phase can therefore branch on data that does not exist in the authoritative snapshot.

#### Reproduction Evidence

The initial state contained a `Date` instance.

Persisted snapshot:

```json
{
  "when": "2026-01-01T00:00:00.000Z"
}
```

First-phase observation:

```json
{
  "phaseSawDate": true,
  "phaseType": "object"
}
```

The phase observed a `Date`, while `state.json` contained a string.

#### Impact

- A restarted execution can make a different decision from the original process.
- The first invocation and resumed invocations do not share the same state semantics.
- `Date`, `Map`, `Set`, `undefined`, `NaN`, and schema transformations can create similar divergence.
- Recursive freezing does not make `Map`, `Set`, or `Date` internal slots immutable.

#### Recommended Correction

Choose one explicit JSON boundary policy:

1. Reject all non-JSON-compatible state before any durable write; or
2. Canonicalize state through the exact persistence representation and pass that canonical value to the phase.

Apply schema parsing and transformations consistently on both write and read. Add tests proving that the value received by every phase is structurally identical to the value represented by the authoritative snapshot.

### TL-F-006 — Batch Job Identifiers Can Escape or Collide in the Result Directory

- **Severity:** High
- **Confidence:** Confirmed by direct binding reproduction
- **Resolution class:** Decisional

#### Affected Code

- `src/engine/delegate-handler.ts:60-75`
- `src/bindings/batch.ts:25-34`
- `src/engine/shared.ts:51-60`
- `src/engine/handle-resume.ts:17-25`
- `tests/bindings/batch-binding.test.ts:142-146`

#### Observation

Batch validation rejects only exact duplicate IDs. Each ID is then interpolated into a filesystem path and normalized by `path.join()`.

No lexical restriction, canonical-path collision check, or containment check is applied.

#### Reproduction Evidence

With run directory `/safe/root/orch/run`, this ID was accepted:

```text
../../../../../../tmp/owned
```

The generated result path was:

```text
/tmp/owned.json
```

Distinct IDs can also normalize to the same path. For example, `a` and `x/../a` both resolve to the same result filename under the batch directory.

#### Impact

- The generated manifest can instruct a host to write outside the run directory.
- Two logical jobs can overwrite the same result file.
- Batch result ordering and job-to-result correspondence can be corrupted.
- Retry reconstruction reproduces the unsafe paths on every attempt.

#### Recommended Correction

Define a closed, path-safe grammar for job IDs and validate it before manifest construction. Independently resolve every generated path and verify that it remains a direct child of the intended attempt directory.

Check uniqueness after canonical path construction, not only before normalization. Add generated tests over separators, dot segments, empty IDs, Unicode normalization, and IDs that normalize to the same path.

### TL-F-007 — Protocol String Serialization Is Not Round-Trip Safe

- **Severity:** High
- **Confidence:** Confirmed by direct writer/parser reproduction
- **Resolution class:** Decisional

#### Affected Code

- `src/services/protocol.ts:46-53`
- `src/services/protocol.ts:147-163`
- `src/services/protocol.ts:181-211`
- `src/services/run-id.ts:3-10`
- `tests/services/protocol.test.ts:248-291`

#### Observation

The writer leaves strings unquoted unless they contain a small set of special characters. The parser then coerces the unquoted literals `null`, `true`, `false`, and numeric-looking values into non-string types.

This makes serialization dependent on string contents rather than the declared field type.

#### Reproduction Evidence

A standard mixed-character ULID with orchestrator name `null`, `true`, or `false` produced a block that `parseProtocolBlock()` rejected because `orchestrator` was no longer parsed as a string.

A normal orchestrator name with the accepted all-zero ULID also produced a block that the parser rejected because `run_id` was parsed as a number.

The current round-trip test covers one safe fixture and does not generate reserved scalar strings.

#### Impact

- The writer's own parser rejects blocks produced from accepted runtime inputs.
- Host implementations can disagree on scalar coercion.
- Error messages or phase names equal to reserved literals change type during parsing.
- Control characters outside the writer's special-character regex are not consistently encoded.

#### Recommended Correction

Use a type-preserving representation. The smallest compatible correction is to JSON-quote every string and parse quoted values strictly. A stronger redesign is a framed JSON object with action-specific validation.

Add generated round-trip tests over arbitrary strings, reserved literals, numeric strings, empty strings, Unicode, and all control characters. Validate the required body fields for each action rather than only the common header.

### TL-F-008 — The Built Package Is Not Executable Under the Advertised Node Runtime

- **Severity:** High
- **Confidence:** Confirmed against the built artifact
- **Resolution class:** Decisional

#### Affected Code

- `package.json:5-15`
- `package.json:36-37`
- `tsconfig.json:4-5`
- `tsconfig.build.json`
- `README.md:234`

#### Observation

The package advertises Node 22 support and exports `dist/index.js`. TypeScript is configured with `module: "ES2022"` and `moduleResolution: "bundler"`, so emitted JavaScript keeps extensionless relative imports such as:

```js
export { PROTOCOL_VERSION } from "./constants";
```

Node ESM does not resolve that specifier to `./constants.js`.

#### Reproduction Evidence

The build completed successfully. Importing the result produced:

```text
ERR_MODULE_NOT_FOUND: Cannot find module '<workspace>/dist/constants'
```

The same built artifact imported successfully under Bun.

#### Impact

- A package consumer following the Node requirement cannot import the public entry point.
- Type checking and build success do not detect the broken distribution artifact.
- Publishing the current `dist` would expose a runtime that works only under Bun despite its metadata.

#### Recommended Correction

Make an explicit runtime-support decision:

- For Node support, emit Node-compatible ESM using explicit `.js` specifiers or a build process that rewrites or bundles them.
- For Bun-only support, remove the Node engine and README claim.

Add package-level smoke tests that build the project and import the exact exported artifact under every advertised runtime.

### TL-F-009 — The Test Suite Overstates Property and Concurrency Coverage

- **Severity:** High
- **Confidence:** Confirmed by test-source inspection
- **Resolution class:** Mechanical

#### Affected Code

- `package.json:33`
- `tests/services/run-id.test.ts:20-33`
- `tests/lock/lock.test.ts:394-410`
- `tests/bindings/batch-binding.test.ts:142-146`
- `tests/contracts/test-integrity.test.ts`

#### Observation

The test suite uses property-oriented names but does not import `fast-check` anywhere, despite declaring it as a development dependency.

Several representative tests provide little or no signal:

- `T-ID-04` computes `sorted` and asserts `expect(sorted).toEqual(sorted)`, which cannot fail.
- `P-ID-a` does not compare generation order with chronological order.
- `P-LK-c` labels itself a mutex property but performs sequential calls in one process.
- `P-BT-c` checks only five hardcoded safe IDs and misses normalization collisions.
- The test-integrity check verifies the presence of assertion-like text but does not detect tautological assertions or false concurrency claims.

#### Verification Evidence

Nominal checks all passed:

| Check | Result |
| ----- | ------ |
| `bun test` | 273 passed, 0 failed |
| Biome | Passed |
| TypeScript type check | Passed |
| Build | Passed |

However, `bun test --coverage` reported 64.59% line coverage and 57.75% function coverage. Engine modules appeared as uninstrumented because their meaningful tests execute in child processes, so the current coverage report cannot assess the core runtime accurately.

Findings TL-F-001, TL-F-002, TL-F-003, TL-F-005, TL-F-006, and TL-F-007 all passed through the existing green suite undetected.

#### Impact

- Green test output materially overstates confidence in concurrency and property invariants.
- Regressions in the process lifecycle can remain invisible to coverage reporting.
- The unused `fast-check` dependency implies a testing capability that is not actually exercised.
- Tautological tests satisfy integrity checks while proving no behavior.

#### Recommended Correction

- Replace fixed examples labeled as properties with genuine generated tests, or rename them honestly as examples.
- Add real multiprocess lock tests.
- Add process-level tests for repeated initial invocation, stdout backpressure, and post-acquisition fault injection.
- Add arbitrary-string protocol round-trip properties.
- Add arbitrary job-ID path-containment properties.
- Collect child-process coverage or use a separate acceptance-test coverage mechanism.
- Strengthen test-integrity checks to detect self-comparisons and tests that never vary their inputs.
- Remove `fast-check` if property testing is no longer intended.

## 4. Decisions Required

| Decision | Why it is needed |
| -------- | ---------------- |
| Locking primitive and stale-takeover algorithm | The current file replacement design cannot provide atomic owner transfer |
| Existing-run behavior in initial mode | The runtime must explicitly reject, adopt, or reset an existing run; silent reset is unsafe |
| JSON boundary policy for state | The runtime must either reject non-JSON values or canonicalize before phase execution |
| Job identifier grammar | Path construction requires a closed lexical contract or an encoded filename scheme |
| Protocol encoding | Fixing scalar ambiguity may require a protocol-version decision |
| Supported production runtimes | Build behavior and package metadata must agree on Bun-only versus Bun and Node |

## 5. Unverified Areas

- Power-loss durability and filesystem `fsync` behavior were not fault-injected.
- Windows behavior was not evaluated; the runtime and tests were reviewed as POSIX-oriented.
- A live host consumer was not run end to end; protocol behavior was tested with local parent processes.
- Dependency vulnerability and supply-chain auditing were outside this review.
- Performance under large state, manifest, and result files was not benchmarked.

## 6. Final Verdict

The nominal one-process flows are coherent and well covered by readable end-to-end tests. The failure model is not yet durable enough for the guarantees advertised by the runtime: stale-lock takeover can admit multiple owners, initial re-entry can replay stale results, protocol output can disappear after a successful exit, and some failures retain the lock.

The codebase should return to reliability hardening before broader adoption. Resolve TL-F-001 through TL-F-005 first, then rebuild the test safety net around real process concurrency, backpressure, re-entry, and JSON-boundary behavior.
