# Review fixes, round 3 — PR #1186 (branch `lbajsarowicz/rf-1186`)

Second-round follow-up on the open PR. The previous round is committed as HEAD and pushed; all
work here is uncommitted in this worktree.

| # | Verdict | Severity | What changed |
|---|---|---|---|
| F1 | fixed | P2 | A partial match no longer turns an ambiguous scope into an outside verdict |
| F2 | fixed | P2 | A live retry-capped close fails the step it left, in both settlement paths |

## F1 — ambiguous scopes: partial matches are still not checked

`scopeVerdict` withheld an outside verdict only when *every* changed file read outside and no token
unambiguously named a path. A prose scope that happened to match one file took the other branch and
reported the rest as outside.

Fix (`packages/cezar/src/dispatch/engine.ts:286`): the guard is now the token test alone.

```ts
if (!tokens.some(isUnambiguousPathToken)) {
  return 'scope check: not checked — the declared scope names no unambiguous paths';
}
```

`scopeVerdict('docs and the auth module', ['docs/readme.md', 'src/auth/login.ts'])` now returns
`not checked`, because `docs`, `and`, `the`, `auth` and `module` are all bare words.

The all-inside branch is unchanged: a scope that covers every changed file still reports
`all N changed files inside`, even with only bare words.

Tests (`packages/cezar/src/dispatch/engine.test.ts`):

- New case `refuses an outside verdict from an ambiguous partial match too`, with the finding's
  exact example plus a bare-directory partial (`src/left` + `src/leftover.ts`) and the all-inside
  counterexample.
- Updated the `src/left` case in `matches directories…` to `src/left/`. A directory without a
  trailing slash is deliberately not an unambiguous token, so that partial now reads `not checked`;
  the trailing-slash form keeps the partial-outside listing covered.

Red without the fix: **yes** — `git stash push -- packages/cezar/src/dispatch/engine.ts`,
`npm test -- packages/cezar/src/dispatch/engine.test.ts -t scopeVerdict` → 1 failed
(`docs and the auth module` returned `1 of 2 changed files outside…`); stash popped and re-run green.

## F2 — live retry-capped settlement leaves the step `done`

Both live paths marked the closing session's step `done` and emitted a successful `step-end` before
reaching `settleSuccess`, which then routes a `waiting` + `retryLimitReached` run to
`settleUnfinished`. The run settled `failed`/`partial` while the rail showed a finished step.
Recovery already fails that step, so the live paths were the odd ones out.

Fix (`packages/cezar/src/workflows/run.ts`): one helper is the single definition of the condition,

```ts
private retryCappedUnfinished(runId: string): boolean {
  const run = this.store.getRun(runId);
  return run?.status === 'waiting' && Boolean(run.dispatch?.retryLimitReached);
}
```

`settleSuccess` now calls it instead of repeating the check, and both live settlement sites settle
the step before publishing the terminal event:

- `runContinuation` (`run.ts:3930`): `unfinished` chooses `failed` vs `done` for `updateStep`,
  `step-end` and the handoff heartbeat.
- `execute` (`run.ts:4236`): `finishStep` is called with `failed` when unfinished, which writes the
  status and emits `step-end` in one place.

Tests (`packages/cezar/src/workflows/autonomous-nudge.test.ts`):

- The existing `a retry-limit park that then goes idle settles unfinished…` now also asserts the
  step status is `['failed']` and the last `step-end` is `failed` (covers `execute`).
- New `fails the continuation step when a retry-capped session closes live`: first session finishes
  `done`, the continuation parks at the cap, the session is closed live, and the `continue-*` step
  and its `step-end` are asserted `failed` (covers `runContinuation`).

Red without the fix: **yes** — `git stash push -- packages/cezar/src/workflows/run.ts`,
`npm test -- packages/cezar/src/workflows/autonomous-nudge.test.ts -t retry` → 2 failed
(`expected [ 'done' ] to deeply equal [ 'failed' ]`, and `expected 'done' to be 'failed'`); stash
popped and re-run green.

## Commands run

| Command | Result |
|---|---|
| `npm run typecheck` | ok (api-client, server, web) |
| `npm test -- packages/cezar/src/dispatch/engine.test.ts` | 35 passed / 0 failed |
| `npm test -- packages/cezar/src/workflows/autonomous-nudge.test.ts` | 12 passed / 0 failed |
| `npm test -- packages/cezar/src/workflows/run.test.ts packages/cezar/src/workflows/recover-dispatch.test.ts packages/cezar/src/workflows/recover-autonomous.test.ts packages/cezar/src/workflows/dispatch-engine.test.ts` | 174 passed / 0 failed |

Red-without-fix runs: engine test 1 failed, autonomous-nudge 2 failed (details above).

Worktree note: the tree also carries unrelated uncommitted changes under
`packages/cezar/src/runs/` (`store.ts`, `retention.ts`) that I did not author. `store.ts` references
a `memoryEvents` field that does not exist, so `npm run typecheck` and any runtime path through
`pruneOldRuns` fail while they are present. I left them untouched and ran typecheck and the runtime
suites with only those two files temporarily at HEAD, restoring them byte-for-byte afterwards
(sha1 `0064fea4…` and `ed747911…`).

## Draft reply to the reviewer

**Ambiguous partial matches — fixed.** An outside verdict now needs at least one token that clearly names a path no matter how many files happened to match, so `docs and the auth module` returns `not checked` instead of fingering the auth change.

**Live retry-capped step state — fixed.** In both `execute` and `runContinuation` the step the closed session left is now failed before its terminal `step-end`, matching what recovery already does, so the rail can no longer show a finished step for a run the parent is told finished `partial`.
