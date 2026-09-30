# Fix waiting-session idle timeout

Goal: make the plain waiting-session idle timeout configurable without changing its 15-minute default, while retaining durable monitoring behavior and all terminal safeguards.

Scope: workflow idle timer; workspace resource schema/semaphore and API contract; Global Settings → Resources; focused regression/config/UI tests. Non-goals: task-thread UI, transcript markdown, installer modules, monitoring classification, wall-clock provider timeout, and changing timeout expiry semantics.

## Implementation Plan

### Phase 1: Configuration and lifecycle

- [x] 1.1 Add optional `idleTimeoutMinutes` resource defaults, bounds, API contract, and semaphore cache/getter. — ccc8939e
- [x] 1.2 Replace the workflow constant use with the cached setting and preserve timer expiry behavior; test new-run and continuation park paths. — ccc8939e

### Phase 2: Operator surface and verification

- [x] 2.1 Add the timeout control and explanatory copy to Global Settings → Resources with focused UI tests. — ccc8939e
- [x] 2.2 Run focused regression/config/API/UI tests and prove the regression test is red against the pre-fix implementation. — ccc8939e
- [x] 2.3 Run the full configured validation gate, review diff, and document compatibility/evidence. — ccc8939e

## Evidence

- PR #1176: https://github.com/open-mercato/cezar/pull/1176
- Head: `0d670be42e2e98509524bb97a0b09f6b89edeedc`
- Focused tests and typecheck/build/package gates pass; full `npm test` has eight unrelated environment-sensitive failures documented in the PR.

## Risks

- A missing or invalid setting must keep the 15-minute safeguard.
- Monitoring parks must remain exempt from this timer and continue using their existing wake policy.

Source doc: `.ai/specs/2026-07-24-long-running-waiting-sessions.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Configuration and lifecycle

- [x] 1.1 Add optional `idleTimeoutMinutes` resource defaults, bounds, API contract, and semaphore cache/getter. — ccc8939e
- [x] 1.2 Replace the workflow constant use with the cached setting and preserve timer expiry behavior; test new-run and continuation park paths. — ccc8939e

### Phase 2: Operator surface and verification

- [x] 2.1 Add the timeout control and explanatory copy to Global Settings → Resources with focused UI tests. — ccc8939e
- [x] 2.2 Run focused regression/config/API/UI tests and prove the regression test is red against the pre-fix implementation. — ccc8939e
- [x] 2.3 Run the full configured validation gate, review diff, and document compatibility/evidence. — ccc8939e
