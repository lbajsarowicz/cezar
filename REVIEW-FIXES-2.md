# REVIEW-FIXES-2: PR #1189, second-round follow-up

Branch: `lbajsarowicz/rf-1189`, worktree from the PR tip (`HEAD` = `143c9393`).
All changes left uncommitted. No commit, no push, no rebase.

## Findings

### [P1] Protect continued runs from the background retention sweep (`packages/cezar/src/runs/project-context.ts:233-236`)

Verdict: **fixed** (confirmed real; reproduced in a test).

`reclaimWorktrees` snapshotted the eligible ids once, then awaited each removal while
using only the snapshot. Because the sweep now runs in the background, a Continue could
land between the snapshot and a deletion, and the loop would still delete the resumed
run's worktree.

The fix lives inside `reclaimWorktrees` (`packages/cezar/src/runs/retention.ts`), the one
chokepoint every caller shares. Each candidate's eligibility is captured before the
loop's first `await`, and the run is re-read live immediately before its deletion. It is
skipped when:

- it left the finished set (`isReclaimable` false: continued/re-queued, or freshly
  `worktreeReclaimedAt`-stamped),
- its `worktreePath` changed, or
- its step list grew since the snapshot.

The step-list check is the early signal a status check alone misses: `continueRun`
records the new `continue-*` step synchronously, while the status only flips to
`running` after the resumed session is under way. There is no `await` between the recheck
and the `remove` call, so a Continue that starts before the deletion is always seen.

Boot path coverage (`sweepStartupWorktrees` after listen in `index.ts`) and
project-context share the same code path, so one fix covers both:

- `packages/cezar/src/index.ts:398` → `sweepStartupWorktrees` → `reclaimWorktrees`
- `packages/cezar/src/server/project-context.ts:234` → `sweepStartupWorktrees` → `reclaimWorktrees`
- `packages/cezar/src/workflows/run.ts:2653` (`enforceRetention`) → `reclaimWorktrees`
- `packages/cezar/src/server/server.ts:5127` (manual reclaim route) → `reclaimWorktrees`

`RetentionStore` gained `getRun(id)` so the enforcer can take a live read; `RunStore`
already provides it.

Tests (both in `packages/cezar/src/runs/retention-enforce.test.ts`, real git worktrees,
`keep = 1`):

- `keeps a continued run's worktree when its status flips after the retention snapshot`
- `keeps a continued run's worktree when only its step list grew after the snapshot`

### [P2] Release buffered transcripts when old runs are pruned (`packages/cezar/src/runs/store.ts:1268-1270`)

Verdict: **fixed** (confirmed real; reproduced in a test).

In a read-only session events are buffered in memory (`memoryEvents`) and `readEvents`
serves that buffer. `deleteRun` cleared the buffer, but `pruneOldRuns` (the automatic,
count-based retention) did not, so a pruned run's transcript stayed readable (and
resident) for the life of the process.

`pruneOldRuns` now clears `memoryEvents` for each pruned id, alongside `seqs` (the same
pair `deleteRun` clears), mirroring explicit deletion.

Test (in `packages/cezar/src/runs/store.test.ts`, read-only data dir):
`drops a pruned run's buffered transcript instead of leaking it for the process lifetime`
creates 306 runs with one buffered event each, asserts exactly 6 are pruned, that each
pruned run's `readEvents` is empty, and that a kept run's buffer still serves.

## Tests added

| Test | Red without the fix? |
| --- | --- |
| `retention-enforce > keeps a continued run's worktree when its status flips after the retention snapshot` | yes (P1) |
| `retention-enforce > keeps a continued run's worktree when only its step list grew after the snapshot` | yes (P1, step-list half) |
| `store > drops a pruned run's buffered transcript instead of leaking it for the process lifetime` | yes (P2) |

Red proof: `git stash push -- packages/cezar/src/runs/retention.ts packages/cezar/src/runs/store.ts`,
then `npm test -- packages/cezar/src/runs/retention-enforce.test.ts packages/cezar/src/runs/store.test.ts`
reported `Test Files 2 failed (2)`, `Tests 3 failed | 135 passed (138)`, the two P1 tests
and the P2 test. `git stash pop` restored the sources.

## Commands run

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test -- packages/cezar/src/runs/retention-enforce.test.ts packages/cezar/src/runs/retention.test.ts packages/cezar/src/runs/startup-sweep.test.ts packages/cezar/src/runs/store.test.ts` | 148 passed (4 files) |
| `npm test -- packages/cezar/src/server/project-context.test.ts packages/cezar/src/runs/retention.test.ts packages/cezar/src/runs/retention-enforce.test.ts packages/cezar/src/runs/startup-sweep.test.ts packages/cezar/src/runs/store.test.ts` | 158 passed (5 files) |
| red run (sources stashed) | 3 failed / 135 passed (2 files) |

Full `npm test`, `npm run build` and `npm run test:package` not run, per instructions.

## Files changed

- `packages/cezar/src/runs/retention.ts`: live eligibility recheck before each reclaim; `RetentionStore.getRun`.
- `packages/cezar/src/runs/retention-enforce.test.ts`: two P1 regression tests; fake store gains `getRun`.
- `packages/cezar/src/runs/store.ts`: `pruneOldRuns` clears `memoryEvents` + `seqs`.
- `packages/cezar/src/runs/store.test.ts`: P2 regression test.

## Draft reply to the reviewer

On P1: you were right, and I reproduced it. `reclaimWorktrees` now re-reads each candidate live right before deleting it and skips any run that left the finished set or grew a step since the snapshot, so a Continue that starts before the deletion keeps its worktree.

On P1 boot path: the boot sweep after listen and the project-context sweep both go through `sweepStartupWorktrees` → `reclaimWorktrees`, so the fix covers both, as do terminal-transition enforcement and the manual reclaim route, since they share the same chokepoint.

On P1 tests: two regression tests drive a real worktree store with `keep = 1`; one flips the run's status mid-sweep, the other only adds the `continue-*` step (the early signal before the status changes). Both fail without the source fix.

On P2: `pruneOldRuns` now clears the in-memory transcript buffer (and the seq counter, matching `deleteRun`) for every pruned run, so retention bounds memory the same way it bounds `runs.json`. A read-only regression test creates 306 runs and asserts each pruned run's `readEvents` is empty.
