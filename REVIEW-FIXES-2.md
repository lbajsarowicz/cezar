# Review fixes (rounds 2 and 3): PR #1183 (monitoring exit)

Branch worktree: `rf-1183`, base HEAD `ab0338c0` (round-1 fix already committed and pushed).
All round-2 and round-3 changes are uncommitted in this worktree; no commit, push or rebase was performed.

Two review rounds landed on the same code. In round 2 the reviewer posted the same finding twice (identical text); it is verified and fixed once, and the duplicate is noted rather than counted again.

## Findings

| # | Round | Severity | Finding | Disposition |
|---|-------|----------|---------|-------------|
| 1 | 2 | P2 | A parent at `MAX_AUTO_CONTINUES` with a queued/in-flight child stays `monitoring`; the interval exit is spent, and the round-1 change also cleared the liveness timer. Cancelling that queued child persists its report without delivering it and does not pump the manager, so the parent has no timer left and stays `running`/`monitoring` forever. | **fixed** (round 2) |
| 2 | 3 | P2 | The round-2 fix armed the liveness fallback with a one-shot `{ atCap: true }`. When a child is still in flight at the first liveness expiry, the callback re-armed without the override, the interval guard rejected it, and both timers were gone — the same deadlock, one liveness window later. | **fixed** (round 3) |

## Round 2

### Verification

Confirmed the defect before changing anything:

- The cap state (`monitoringWakeCapReached` with a child in flight) returned with no wake timer and, after round 1, no liveness timer. The only remaining nudge was the child's report, and `reportSettledChildToParent` deliberately stops at "persist" for a `cancelled` child (`run.ts:2310`), while `cancelOne`'s queued branch (`run.ts:2829-2841`) settles the record and returns without a pump. So a queued-cancel left the parent with no exit at all.
- This is a transition-out-of-state gap in the sense of AGENTS.md § "Enumerate the transitions out of every state you add or keep": the cap state's one exit assumed a delivering report.

### What changed

`packages/cezar/src/workflows/run.ts`

- `armMonitoringWakeTimer` checks the wake-up cap before clearing the liveness timer. Below the cap an interval remains the sole exit (round-1 behaviour, no tie at 60m); at the cap the liveness bound is allowed to return.
- `monitoringWakeCapReached` arms the liveness bound when the run still awaits children. It arms only when no liveness timer is set, so a routine `pump()`/reconcile cannot push the deadline out.

### Tests

`keeps a fallback exit for a capped monitor whose queued child is cancelled without delivering`, in `packages/cezar/src/workflows/monitoring-exit.test.ts`.

Boots with `interval = 5`, parks a parent with a `queued` child, sets the parent at the wake-up cap, advances one interval, and asserts the liveness fallback is armed while the wake timer is gone. It then mirrors `cancelOne`'s queued branch (child `cancelled` + `reportSettledChildToParent`, no pump), asserts the report is persisted but the parent is still `monitoring`, and advances the liveness window to prove the hand-off to `waiting`/`askParked`.

**Proved red without the source fix** (`git stash push -- packages/cezar/src/workflows/run.ts`, run, confirm red, `git stash pop`):

```
AssertionError: expected undefined to be defined
 ❯ src/workflows/monitoring-exit.test.ts:286:50
    266|     expect(stateOf(id)?.monitoringLivenessTimer).toBeDefined();
```

## Round 3

### Verification

Confirmed the new defect before changing anything:

- Line 5526 re-armed with `armMonitoringLivenessTimer(runId, state)` after the liveness callback found a child still in flight. `atCap` defaulted to false, the guard at 5521 saw a configured interval and returned early, and `clearMonitoringLivenessTimer` had already run, so no wake timer and no liveness timer remained. A queued child cancelled after that point left the parent monitoring with no exit, which is the round-2 deadlock recurring one window later.
- The callback only preserves the override if the at-cap state outlives the single arm call, which a default-valued parameter does not.

### What changed

`packages/cezar/src/workflows/run.ts`

- `ActiveRun` gains `monitoringLivenessAtCap`, set whenever a liveness timer is armed and cleared with it. The arm call sites and the callback re-arm now thread the state explicitly, so every re-arm from the timer keeps the cap allowance.
- `armMonitoringLivenessTimer` takes `atCap = false` and stores it on the state before scheduling; the callback re-arms with `state.monitoringLivenessAtCap === true` instead of relying on a one-shot option.
- `clearMonitoringLivenessTimer` clears the flag with the timer, so a park-mode or below-cap park cannot inherit a stale allowance.

No new `CEZ_*` env var, no default change, no new persisted state.

### Tests

`keeps the at-cap fallback when a child outlives the first liveness window and is then cancelled`, in `packages/cezar/src/workflows/monitoring-exit.test.ts`.

Boots with `interval = 5`, parks a parent with a `queued` child, sets the parent at the wake-up cap, and advances one interval: the child is still in flight, so the cap arms the liveness fallback and `monitoringLivenessAtCap` is true. It advances the full liveness window with the child still in flight and asserts the fallback re-armed (timer defined, flag still true). Only then does it cancel the queued child and run `reportSettledChildToParent`, assert the report is persisted and the parent still `monitoring`, and advance a further liveness window to prove the hand-off to `waiting`/`askParked`.

**Proved red against the round-3 fix alone.** Stashing `run.ts` reverts to committed HEAD and therefore removes the round-2 fix too, which fails earlier and would not isolate this finding. So the callback re-arm was reverted in place (`this.armMonitoringLivenessTimer(runId, state, state.monitoringLivenessAtCap === true)` to `this.armMonitoringLivenessTimer(runId, state)`), keeping round 2 and everything else:

```
AssertionError: expected undefined to be defined
 ❯ src/workflows/monitoring-exit.test.ts:324:50
    324|     expect(stateOf(id)?.monitoringLivenessTimer).toBeDefined();
```

Line 324 is the assertion after the first liveness window, i.e. exactly the re-arm the reviewer flagged. The file was restored byte-for-byte afterwards (verified with `diff` against a pre-revert copy).

Existing guards that still pass and pin the round-1/round-2 behaviour: the park-mode liveness hand-off, the `interval = 60` first-wake test (liveness stays undefined below the cap), the in-flight-child no-blind-wake test, and the round-2 queued-cancel test before the second window.

## Commands run

| Command | Result |
|---------|--------|
| `npm run typecheck` | clean (api-client, server, web) |
| `npm test -- packages/cezar/src/workflows/monitoring-exit.test.ts` | 1 file, 23 passed |
| stash `run.ts` + round-2 test (`-t`) | 1 failed, 21 skipped (red at line 286) |
| in-place revert of the round-3 re-arm + round-3 test (`-t`) | 1 failed, 22 skipped (red at line 324) |
| restore + `diff` against backup | identical |
| `npm test -- packages/cezar/src/workflows/monitoring-exit.test.ts packages/cezar/src/workflows/non-final-monitoring.test.ts packages/cezar/src/workflows/dispatch-engine.test.ts packages/cezar/src/workflows/recover-dispatch.test.ts` | 4 files, 56 passed |

## Draft reply to the reviewer

Both rounds were real, and both are fixed.

Round 2: the cap state was the gap. Once the wake-up interval is spent and a child is still in flight, the only exit was the child's report, and a `cancelled` child deliberately persists its report without delivering it, so a queued cancel left the parent bounded by nothing. The fix restores the liveness bound as the fallback for exactly that state, armed only when none is set, while below the cap an interval stays the sole exit so the round-1 60-minute tie stays gone.

Round 3: you caught that the fallback itself used a one-shot override. The callback re-armed with the default `atCap = false`, the interval guard rejected it, and both timers were gone one window later. The at-cap state now lives on the `ActiveRun` (`monitoringLivenessAtCap`) and every re-arm from the timer carries it, so a child that outlives the first window no longer costs the run its exit. The new test exercises exactly that path (cap, first liveness window with the child still in flight, re-arm, then a queued cancel with no report) and fails at the re-arm assertion without the change.
