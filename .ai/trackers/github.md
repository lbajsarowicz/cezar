# Tracker provider: GitHub

This file is the GitHub implementation of the tracker operations contract (see `TEMPLATE.md` for the contract itself). Every skill in the collection performs issue/PR state management through **named tracker operations** — `**get-issue**`, `**comment-pr**`, and so on — and this file defines what each operation means for GitHub, using the `gh` CLI.

How it is used at runtime: `om-setup-agent-pipeline` copies this file into the repository at `.ai/trackers/github.md`, and the config's `tracker` field selects it. When a skill says "tracker operation **get-pr**", execute the command documented under that operation heading in the repo's copy. The repo's copy is authoritative: teams extend or override any operation by editing it — add flags, swap a command, append repo-specific conventions — and every skill picks the change up on its next run. An operation not covered by an edit keeps its behavior from this file's text as copied.

## Prerequisites

- `gh` CLI installed and authenticated. Verify with the **auth-check** operation before a batch run; fail fast when unauthenticated.
- All operations accept an optional `{repo}` (`owner/name`); when omitted, `gh` infers it from the current checkout's git remote. Pass `--repo {owner}/{repo}` explicitly whenever a skill operates on a repository other than the current one.

## Conventions

- Issue and PR identifiers are numbers; in text they are written `#123`.
- A PR is linked to the issue it resolves with `Fixes #{issueId}` (or `Closes #{issueId}`) in the PR body; GitHub then closes the issue on merge. To reference without auto-closing, use a plain issue link.
- PRs open as **drafts** when a skill says so; a human (or **mark-pr-ready**) promotes them.
- Claim/lock signals on an issue or PR are: assignee set to the automation user, the `in-progress` label, and a `🤖`-prefixed claim comment. All three are set on claim; the label is guarded (below).
- Long, multi-line comment bodies are posted with `--body-file` (or a heredoc via process substitution) so formatting is preserved.
- CI status truth comes from **get-pr-checks**; the set of *required* checks comes from **get-required-checks**. Both of its reads mean "nothing is required" when there is no branch protection (the `--required` query reports no required checks, and the fallback endpoint answers HTTP 404); a 401/403 on the fallback means protection is unreadable and is surfaced as an error rather than guessed away.

## Label guards

Every label mutation goes through an existence guard so a missing label degrades to a logged skip instead of a failure, and `labels.enabled: false` in the config skips label operations entirely.

```bash
# The repo's label names are fetched once per shell and reused, so a batch of guard
# checks costs one API round trip rather than one per label. Call repo_labels with no
# pipe: a pipeline would run it in a subshell and throw the cache away. A failed fetch
# leaves the cache empty, so the next guard retries instead of treating every label as
# absent.
repo_labels() {
  if [ -z "${REPO_LABELS-}" ]; then
    REPO_LABELS=$(gh label list --limit 200 --json name --jq '.[].name')
  fi
}

label_exists() {
  repo_labels
  grep -Fxq "$1" <<EOF
$REPO_LABELS
EOF
}

# PR labels
apply_label() {
  if [ "$LABELS_ENABLED" != "true" ]; then return 0; fi
  if label_exists "$1"; then
    gh pr edit "$2" --add-label "$1"
  else
    echo "Skipping label '$1' (not defined in this repo). Create it with: gh label create '$1'"
  fi
}

# Issue labels
apply_issue_label() {
  if [ "$LABELS_ENABLED" != "true" ]; then return 0; fi
  if label_exists "$1"; then
    gh issue edit "$2" --add-label "$1"
  else
    echo "Skipping label '$1' (not defined in this repo). Create it with: gh label create '$1'"
  fi
}

remove_issue_label() {
  if [ "$LABELS_ENABLED" != "true" ]; then return 0; fi
  if label_exists "$1"; then
    gh issue edit "$2" --remove-label "$1"
  fi
}

# Pipeline labels are mutually exclusive. The target is added and the siblings that
# are actually present are removed in a single call, then the resulting set is read
# back: a partial failure must not leave the PR with no pipeline label.
set_pipeline_label() {
  if [ "$LABELS_ENABLED" != "true" ]; then return 0; fi
  pr="$1"
  target="$2"
  if ! label_exists "$target"; then
    echo "Skipping label '$target' (not defined in this repo). Create it with: gh label create '$target'"
    return 0
  fi
  remove=""
  for label in $PIPELINE_LABELS; do
    [ "$label" = "$target" ] && continue
    label_exists "$label" || continue
    remove="${remove:+$remove,}$label"
  done
  if [ -n "$remove" ]; then
    gh pr edit "$pr" --add-label "$target" --remove-label "$remove"
  else
    gh pr edit "$pr" --add-label "$target"
  fi
  present=$(gh pr view "$pr" --json labels --jq '.labels[].name')
  if ! grep -Fxq "$target" <<EOF
$present
EOF
  then
    echo "set_pipeline_label: '$target' is not on PR #$pr after the transition." >&2
    return 1
  fi
  for label in $PIPELINE_LABELS; do
    [ "$label" = "$target" ] && continue
    if grep -Fxq "$label" <<EOF
$present
EOF
    then
      echo "set_pipeline_label: '$label' is still on PR #$pr after the transition." >&2
      return 1
    fi
  done
}
```

When operating on a different repository than the current checkout, add `--repo "$REPO"` to each command inside the guards and check label existence against that repo (`gh label list --repo "$REPO"`). The cache is not repo-keyed, so `unset REPO_LABELS` before the guards when one shell moves between repositories.

## Operations

### Identity and repository

#### auth-check
Verify the CLI is authenticated. → exit status.
```bash
gh auth status
```

#### current-user
→ the automation user's login.
```bash
CURRENT_USER=$(gh api user --jq '.login')
```

#### repo-info
→ `owner/name` handle and default branch of the current repository.
```bash
gh repo view --json nameWithOwner,defaultBranchRef
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
```

#### default-branch
→ the repository's default branch name (used when the config's `baseBranch` is `"auto"`).
```bash
BASE_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || true)
[ -z "$BASE_BRANCH" ] && BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$BASE_BRANCH" ] && BASE_BRANCH="main"
```

### Issues

#### get-issue
`{issueId}`, field list → issue data. Request only the fields the calling skill names.
```bash
gh issue view {issueId} --repo {owner}/{repo} --json number,title,body,state,author,url,labels,assignees,comments
```

#### search-issues
Query (text, `in:title,body`, state) → matching issues.
```bash
gh issue list --repo {owner}/{repo} --state open --search "<query> in:title,body" --json number,title,url
```

#### create-issue
Title, body, assignee, labels → created issue URL.
```bash
gh issue create --repo {owner}/{repo} --title "<title>" --assignee <login> --label <labels> --body "<body>"
```

#### close-issue
`{issueId}`, reason, closing comment.
```bash
gh issue close {issueId} --repo {owner}/{repo} --reason completed --comment "<comment>"
```

#### comment-issue
`{issueId}`, body (use a heredoc/body-file for multi-line bodies).
```bash
gh issue comment {issueId} --repo {owner}/{repo} --body "<body>"
```

#### update-issue
`{issueId}`, new title and/or body (use a body-file for multi-line bodies). Edits the issue's own fields; does not touch labels or assignees (those have their own operations).
```bash
gh issue edit {issueId} --repo {owner}/{repo} --title "<title>" --body-file <file>
```

#### assign-issue / unassign-issue
```bash
gh issue edit {issueId} --repo {owner}/{repo} --add-assignee "<login>"
gh issue edit {issueId} --repo {owner}/{repo} --remove-assignee "<login>"
```

#### label-issue / unlabel-issue
Always through the guards: `apply_issue_label "<label>" {issueId}` / `remove_issue_label "<label>" {issueId}`.

#### get-issue-comment
Comment id → body, author, URL.
```bash
gh api repos/{owner}/{repo}/issues/comments/{commentId} --jq '{body,user:.user.login,url:.html_url}'
```

#### list-issue-comments
`{issueId or prNumber}` → conversation comments (PR conversation comments are issue comments on GitHub).
```bash
gh api repos/{owner}/{repo}/issues/{number}/comments --jq '.[] | {id,user:.user.login,body}'
```

### Pull requests

#### get-pr
`{prNumber}`, field list → PR data. Request only the fields the calling skill names; the full field set skills use:
```bash
gh pr view {prNumber} --json number,title,url,body,state,author,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify,mergeable,mergeStateStatus,reviewDecision,labels,latestReviews,reviews,commits,files,assignees,comments,mergedAt,mergeCommit,closingIssuesReferences
```

#### list-prs
State/search filters, field list, limit → PRs.
```bash
gh pr list --state open --json number,title,url,author,labels,reviewDecision,mergeable,mergeStateStatus,headRefName,baseRefName,updatedAt,isDraft,assignees --limit 100
gh pr list --state merged --search "merged:>=${SINCE_DATE}" --json number,title,url,body,author,mergedAt,mergeCommit,baseRefName,headRefName,closingIssuesReferences,labels --limit {limit}
gh pr list --state closed --search "closed:>=${SINCE_DATE} is:unmerged" --json number,title,url,body,author,closedAt,baseRefName,headRefName,closingIssuesReferences,labels --limit {limit}
```

#### search-prs
Free-text query (for example an issue reference) and state → matching PRs.
```bash
gh search prs --repo {owner}/{repo} "#{issueId}" --state open --json number,title,url,state
```

#### create-pr
Base branch, draft flag, title, body → PR.
```bash
gh pr create --repo {owner}/{repo} --base "$BASE_BRANCH" --draft --title "<title>" --body "<body>"
PR_URL=$(gh pr view --json url --jq .url)
PR_NUMBER=$(gh pr view --json number --jq .number)
```

#### comment-pr
`{prNumber}`, body. For long structured comments:
```bash
gh pr comment {prNumber} --body-file <path-or-process-substitution>
```

#### attach-image-evidence
`{prNumber}`, a markdown comment body (without the images), a `{slug}` (e.g. `pr-{prNumber}`), and a list of local PNG paths → post one comment with the images embedded **inline**, and return the comment URL.

GitHub does not accept image bytes through the comment API, so make the images referenceable first. For a **public** repo, upload them to a dedicated **slash-free** evidence branch (never the change's own branch) via the Contents API and reference `raw.githubusercontent.com` URLs — those render inline in comments:

```bash
OWNER_REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
EVIDENCE_BRANCH="qa-evidence-{slug}"                 # slash-free: some raw URLs 404 on slashed refs
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)

# create the evidence branch if missing (branched from the default branch head)
gh api "repos/${OWNER_REPO}/git/refs/heads/${EVIDENCE_BRANCH}" >/dev/null 2>&1 || {
  SHA=$(gh api "repos/${OWNER_REPO}/git/refs/heads/${DEFAULT_BRANCH}" --jq .object.sha)
  gh api -X POST "repos/${OWNER_REPO}/git/refs" -f ref="refs/heads/${EVIDENCE_BRANCH}" -f sha="$SHA" >/dev/null
}

# upload each image. An image-sized base64 string blows the shell arg limit, so it
# must never touch a command line — write it to a temp file and let `jq --rawfile`
# read it into the JSON body, which `gh api --input -` sends over stdin. Pass the
# existing blob sha to overwrite on re-runs.
BODY_IMAGES=""
for img in <image-paths>; do
  path="{slug}/$(basename "$img")"
  b64=$(mktemp)                                                 # per-image path: concurrent runs must not share it
  base64 < "$img" | tr -d '\n' > "$b64"                        # portable across GNU/BSD; no newlines
  existing=$(gh api "repos/${OWNER_REPO}/contents/${path}?ref=${EVIDENCE_BRANCH}" --jq .sha 2>/dev/null || true)
  jq -n --rawfile c "$b64" --arg m "qa evidence {slug}" --arg b "$EVIDENCE_BRANCH" --arg s "$existing" \
     'if $s == "" then {message:$m,branch:$b,content:$c} else {message:$m,branch:$b,content:$c,sha:$s} end' \
     | gh api -X PUT "repos/${OWNER_REPO}/contents/${path}" --input - >/dev/null
  rm -f "$b64"
  url="https://raw.githubusercontent.com/${OWNER_REPO}/${EVIDENCE_BRANCH}/${path}"
  BODY_IMAGES="${BODY_IMAGES}\n![$(basename "$img")](${url})"
done

# assemble the comment (caller's body + the image markdown) and post it
{ cat <body-file>; printf "%b" "$BODY_IMAGES"; } | gh pr comment {prNumber} --body-file -
gh pr view {prNumber} --json url --jq .url
```

Fallbacks: for a **private** repo the raw URLs need auth and will not render — post the comment with the image links plus the local artifact paths and note that inline rendering is unavailable (a private-visibility limit), rather than failing. When even the evidence branch cannot be pushed (no write access), degrade to listing the artifact paths in the comment. Never store evidence on the change's own branch, and never force-push.

#### assign-pr / unassign-pr
```bash
gh pr edit {prNumber} --add-assignee "<login>"
gh pr edit {prNumber} --remove-assignee "<login>"
```

#### label-pr / unlabel-pr
Always through the guards: `apply_label "<label>" {prNumber}` / `set_pipeline_label {prNumber} "<label>"` for the mutually exclusive pipeline group; direct removal:
```bash
gh pr edit {prNumber} --remove-label "<label>"
```

#### get-pr-diff
`{prNumber}` → full diff, or the changed-file list with `--name-only`.
```bash
gh pr diff {prNumber}
gh pr diff {prNumber} --name-only
```

#### get-pr-files
`{prNumber}` → changed files with per-file status (added/modified/removed), paginated.
```bash
gh api "repos/{owner}/{repo}/pulls/{prNumber}/files" --paginate --jq '.[] | {path: .filename, status: .status}'
```

#### checkout-pr
`{prNumber}` → the PR's head available locally (needed for cross-repository fork PRs where the head branch cannot be fetched from `origin`).
```bash
gh pr checkout {prNumber} --recurse-submodules=no
```

#### review-pr
`{prNumber}`, verdict (approve / request changes), body.
```bash
gh pr review {prNumber} --approve --body "<body>"
gh pr review {prNumber} --request-changes --body "<body>"
```
GitHub rejects self-approval (reviewing your own PR); surface that instead of working around it.

#### merge-pr
`{prNumber}`; squash is the default merge strategy. `--auto` merges when checks pass; `--delete-branch` only when asked.
```bash
gh pr merge {prNumber} --squash
```

#### mark-pr-ready
Promote a draft PR.
```bash
gh pr ready {prNumber}
```

#### get-pr-checks
`{prNumber}` → CI check runs with name, state, and link.
```bash
gh pr checks {prNumber} --json name,state,link
```

#### get-required-checks
`{prNumber}` → the required status checks for the PR. Ask the PR directly; `--required` keeps only the checks branch protection enforces, and `bucket` gives each one's current state. When branch protection requires nothing, `gh` exits 1 with `no required checks reported` and no JSON — that is "nothing is required", not an error; any other exit 1 is a genuine failure and is re-raised:
```bash
out=$(gh pr checks {prNumber} --required --json name,state,link,bucket 2>&1); status=$?
if [ "$status" -eq 0 ]; then
  printf '%s\n' "$out"
elif printf '%s' "$out" | grep -qi 'no required checks reported'; then
  :  # no check is required
else
  printf '%s\n' "$out" >&2
  false
fi
```
When the raw protection contexts are needed instead, read the endpoint with its headers so a repo with no protection is distinguishable from one whose protection is unreadable:
```bash
resp=$(gh api --include "repos/{owner}/{repo}/branches/${BASE_BRANCH}/protection/required_status_checks" 2>/dev/null || true)
code=$(printf '%s\n' "$resp" | head -1 | awk '{print $2}')
case "$code" in
  200) printf '%s\n' "$resp" | tr -d '\r' | sed '1,/^$/d' | jq -r '.contexts[]' ;;
  404) : ;;  # no branch protection: no check is required
  401|403) echo "get-required-checks: branch protection is unreadable (HTTP $code); surface this error instead of treating every check as required." >&2; false ;;
  *) echo "get-required-checks: unexpected response (HTTP ${code:-none})." >&2; false ;;
esac
```

#### get-pr-comment / get-review-comment
Conversation comment id (`issuecomment-<id>` links) vs inline review comment id (`discussion_r<id>` links) → body, author, URL.
```bash
gh api repos/{owner}/{repo}/issues/comments/{commentId} --jq '{body,user:.user.login,url:.html_url}'
gh api repos/{owner}/{repo}/pulls/comments/{commentId} --jq '{body,user:.user.login,url:.html_url}'
```

### CI runs

CI status for a *PR* comes from **get-pr-checks** / **get-required-checks** above. The operations here address CI runs directly — needed when working from a bare branch, or when a failure diagnosis needs the actual logs.

#### list-runs
Branch (or head SHA) → recent workflow runs with id, workflow name, status, and conclusion.
```bash
gh run list --branch {branch} --limit 20 --json databaseId,workflowName,name,status,conclusion,headSha,url,createdAt
```

#### get-run
Run id → status, conclusion, and per-job breakdown.
```bash
gh run view {runId} --json status,conclusion,workflowName,headSha,url,jobs
```

#### get-run-failed-logs
Run id → the log output of failed steps only. This is the primary diagnosis input for CI failures.
```bash
gh run view {runId} --log-failed
```

#### rerun-failed
Run id → re-execute only the failed jobs of that run. Use to disambiguate flaky failures before changing any code.
```bash
gh run rerun {runId} --failed
```

#### watch-run
Run id → block until the run completes, exiting non-zero on failure. Prefer this over sleep-polling; fall back to periodic **get-run** when watching is unavailable.
```bash
gh run watch {runId} --exit-status
```

### Labels

#### list-labels
→ all label names defined in the repo.
```bash
gh label list --limit 200 --json name --jq '.[].name'
```

#### create-label
Name, color, description. Never delete, rename, or recolor existing labels.
```bash
gh label create <name> --color <hex> --description "<description>"
```

#### ensure-label-taxonomy
Create every label from the config's taxonomy that does not exist yet (used by `om-setup-agent-pipeline`; skip ones that already exist per **list-labels**):
```bash
gh label create review            --color 0366d6 --description "Ready for code review"
gh label create changes-requested --color b60205 --description "Reviewer requested changes"
gh label create qa                --color fbca04 --description "Manual QA in progress"
gh label create qa-failed         --color b60205 --description "Manual QA failed"
gh label create merge-queue       --color 0e8a16 --description "Approved, ready to merge"
gh label create blocked           --color b60205 --description "Blocked by a dependency"
gh label create do-not-merge      --color b60205 --description "Hard merge block"
gh label create bug               --color d73a4a --description "Bug fix"
gh label create feature           --color a2eeef --description "New capability"
gh label create refactor          --color cfd3d7 --description "No behavior change"
gh label create security          --color b60205 --description "Security-relevant change"
gh label create dependencies      --color 0366d6 --description "Dependency update"
gh label create documentation     --color 0075ca --description "Docs only"
gh label create needs-qa          --color fbca04 --description "Requires manual QA before merge"
gh label create skip-qa           --color 0e8a16 --description "Low risk, QA not required"
gh label create qa-approved       --color 0e8a16 --description "Manual QA passed"
gh label create qa-self-verified  --color c5def5 --description "Self-QA exception used"
gh label create in-progress       --color c5def5 --description "An automated skill is working on this"
gh label create ci-monitoring     --color fbca04 --description "An automated skill is watching CI on this"
gh label create do-not-close      --color c5def5 --description "Humans only: never auto-close this issue"
gh label create priority-low      --color e4e669 --description "Cosmetic or follow-up work"
gh label create priority-medium   --color fbca04 --description "Ordinary bug or feature"
gh label create priority-high     --color d93f0b --description "Release-blocking"
gh label create priority-extreme  --color b60205 --description "Outage or security incident"
gh label create risk-low          --color 0e8a16 --description "Isolated, low blast radius"
gh label create risk-medium       --color fbca04 --description "Ordinary change with tests"
gh label create risk-high         --color b60205 --description "Wide blast radius, review deeply"
```
