import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeRetention } from '../config.ts';
import { pruneOrphans } from '../git-worktree.ts';
import { reclaimWorktrees } from './retention.ts';
import type { RunStore } from './store.ts';

/**
 * Boot-time worktree sweep for the boot project: orphan pruning (spec 006) and count-based
 * retention (#483). Best-effort, never throws. It runs while the cockpit already serves, so a
 * run created mid-sweep must count as live: membership is read from the store per entry, never
 * snapshotted when the sweep starts.
 */
export async function sweepStartupWorktrees(
  repoRoot: string,
  store: RunStore,
): Promise<{ orphans: string[]; reclaimed: string[] }> {
  const orphans = await pruneOrphans(repoRoot, { has: (id) => store.getRun(id) !== undefined }).catch(
    () => [] as string[],
  );
  // Reclaims finished worktrees beyond the keep-limit (directory only — `cez/<id8>` branch kept,
  // so recoverable).
  const keep = await resolveWorktreeRetention(repoRoot).catch(() => DEFAULT_WORKTREE_RETENTION);
  const reclaimed = await reclaimWorktrees(repoRoot, store, keep).catch(() => [] as string[]);
  return { orphans, reclaimed };
}
