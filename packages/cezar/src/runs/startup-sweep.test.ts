import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKTREES_DIR } from '../git-worktree.ts';
import { sweepStartupWorktrees } from './startup-sweep.ts';
import { RunStore } from './store.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];
const stores: RunStore[] = [];

async function fixtureRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cez-startup-sweep-'));
  roots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.flush();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('sweepStartupWorktrees', () => {
  it('keeps the worktree of a run created while the sweep is already under way', async () => {
    const root = await fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    stores.push(store);
    const orphanDir = join(root, WORKTREES_DIR, 'orphan-run-id');
    mkdirSync(orphanDir, { recursive: true });

    const sweep = sweepStartupWorktrees(root, store);
    // The cockpit is listening during the sweep: a request creates a run and its worktree.
    const created = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    const liveDir = join(root, WORKTREES_DIR, created.id);
    mkdirSync(liveDir, { recursive: true });

    const { orphans } = await sweep;
    expect(orphans).toEqual(['orphan-run-id']);
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(liveDir)).toBe(true);
  }, 30_000);
});
