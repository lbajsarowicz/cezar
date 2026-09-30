# Execution plan — strip bidi controls from attachment filenames

**Issue:** #988
**Branch:** `cez/3f92bd8e`
**Goal:** Remove bidi/format display-control characters from sanitized attachment filenames while preserving ordinary Unicode names and existing media-type extension pinning.

## Scope

- Update `sanitizeAttachmentName` in `packages/contract/src/runs.ts`.
- Extend the focused sanitizer tests in `packages/cezar/src/workflows/pasted-attachments.test.ts`.
- Preserve all existing path, Windows-name, Unicode, length, and extension-pinning behavior.

## Non-goals

- No resource schemas, workflow, settings, installer, transcript UI, or unrelated attachment behavior.

## Implementation Plan

### Phase 1: Regression and fix

- [ ] 1.1 Add a regression test covering U+202E and the full required bidi/format ranges; prove it fails before the fix.
- [ ] 1.2 Extend the sanitizer character class minimally and prove the focused tests pass.

### Phase 2: Validation and handoff

- [ ] 2.1 Run the complete configured validation gate, document any baseline/unrelated failures, and complete the PR review handoff.

## Risks

The sanitizer is a shared contract helper, so an overbroad Unicode range could damage legitimate filenames. The change will use only the explicitly required display-control ranges and tests will pin ordinary Unicode preservation and extension pinning.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Regression and fix

- [ ] 1.1 Add a regression test covering U+202E and the full required bidi/format ranges; prove it fails before the fix.
- [ ] 1.2 Extend the sanitizer character class minimally and prove the focused tests pass.

### Phase 2: Validation and handoff

- [ ] 2.1 Run the complete configured validation gate, document any baseline/unrelated failures, and complete the PR review handoff.
