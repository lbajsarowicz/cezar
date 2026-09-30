# Fix local transcript link navigation

Goal: prevent transcript links that identify host filesystem paths from implying that a remote cockpit can open them, while preserving confirmation for HTTPS and supported cockpit-relative links.

Scope: `packages/web/src/routes/task-thread/markdown.tsx` and its regression tests.

Non-goals: serving arbitrary host files, adding an artifact endpoint, or changing task-thread/run-header consumers.

## Implementation Plan

### Phase 1: Policy and regression coverage

- [x] 1.1 Add a transcript destination classifier and local-only renderer — targeted tests pass
- [x] 1.2 Preserve safety confirmation for HTTPS and cockpit-relative links — targeted tests pass
- [ ] 1.3 Run the full repository validation gate and authoritative PR review

## Risks

- The repository’s generated API client types may require the server build before typecheck; unrelated baseline errors must be reported if they persist.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

### Phase 1: Policy and regression coverage

- [x] 1.1 Add a transcript destination classifier and local-only renderer — targeted tests pass
- [x] 1.2 Preserve safety confirmation for HTTPS and cockpit-relative links — targeted tests pass
- [ ] 1.3 Run the full repository validation gate and authoritative PR review
