import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTaskDiffBase } from './git-diff-base.ts';
import { createWorktree, worktreeDiff, worktreeDiffStat } from './git-worktree.ts';
import { copyProjectSkills } from './skills-remote.ts';
import type { Skill } from './skills.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(gitignore: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-skill-copy-'));
  dirs.push(root);
  const g = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  g(['-c', 'init.defaultBranch=main', 'init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'a.txt'), 'one\n');
  if (gitignore !== undefined) writeFileSync(join(root, '.gitignore'), gitignore);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'base']);
  return root;
}

function installSkill(root: string, name: string): Skill {
  const dir = join(root, '.agents/skills', name);
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\nbody\n`);
  writeFileSync(join(dir, 'references/ref.md'), 'ref\n');
  return { name, body: 'body', path: join(dir, 'SKILL.md'), source: 'agents' };
}

describe('copyProjectSkills', () => {
  it('copies ignored skill dirs into both native mirrors and keeps them out of every task diff', async () => {
    const root = repo('.agents/\n.claude/skills\n');
    const skill = installSkill(root, 'om-demo');
    const wt = await createWorktree(root, 'run-copy', 'main');

    const copied = await copyProjectSkills(wt.path, [skill]);

    expect(copied.sort()).toEqual(['.agents/skills/om-demo', '.claude/skills/om-demo']);
    expect(readFileSync(join(wt.path, '.agents/skills/om-demo/references/ref.md'), 'utf8')).toBe('ref\n');
    expect(readFileSync(join(wt.path, '.claude/skills/om-demo/SKILL.md'), 'utf8')).toContain('name: om-demo');
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: wt.path, encoding: 'utf8' })).toBe('');
    expect(await worktreeDiff(wt.path, 'main')).toBe('');
    expect(await worktreeDiffStat(wt.path, 'main')).toBe('');
    const gitIn = (args: string[]) => execFileSync('git', args, { cwd: wt.path, encoding: 'utf8' });
    const { base } = await resolveTaskDiffBase(async (args) => {
      try {
        return { ok: true, stdout: gitIn(args) };
      } catch {
        return { ok: false, stdout: '' };
      }
    }, 'main');
    expect(gitIn(['diff', '--stat', base])).toBe('');
    expect(gitIn(['ls-files', '--others', '--exclude-standard'])).toBe('');
    expect(readFileSync(join(root, '.git/info/exclude'), 'utf8')).not.toContain('om-demo');
  });

  it('skips a destination the worktree would not ignore, so nothing lands in the diff', async () => {
    const root = repo(undefined);
    const skill = installSkill(root, 'om-demo');
    const wt = await createWorktree(root, 'run-unignored', 'main');

    expect(await copyProjectSkills(wt.path, [skill])).toEqual([]);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wt.path, encoding: 'utf8' })).toBe('');
  });

  it('never replaces a path that already exists, and is idempotent', async () => {
    const root = repo('.agents/\n.claude/skills\n');
    const skill = installSkill(root, 'om-demo');
    const wt = await createWorktree(root, 'run-existing', 'main');
    mkdirSync(join(wt.path, '.claude/skills/om-demo'), { recursive: true });
    writeFileSync(join(wt.path, '.claude/skills/om-demo/SKILL.md'), 'mine\n');

    expect(await copyProjectSkills(wt.path, [skill])).toEqual(['.agents/skills/om-demo']);
    expect(await copyProjectSkills(wt.path, [skill])).toEqual([]);
    expect(readFileSync(join(wt.path, '.claude/skills/om-demo/SKILL.md'), 'utf8')).toBe('mine\n');
    expect(lstatSync(join(wt.path, '.agents/skills/om-demo')).isDirectory()).toBe(true);
  });

  it('treats a copy as current although its preserved mtime lost the source\'s sub-millisecond part', async () => {
    const root = repo('.agents/\n.claude/skills\n');
    const skill = installSkill(root, 'om-demo');
    utimesSync(skill.path, 1_700_000_000.123_456_7, 1_700_000_000.123_456_7);
    const wt = await createWorktree(root, 'run-precision', 'main');

    expect(await copyProjectSkills(wt.path, [skill])).toHaveLength(2);
    expect(await copyProjectSkills(wt.path, [skill])).toEqual([]);
  });

  it('keeps a write to the worktree copy inside the worktree, never in the main checkout', async () => {
    const root = repo('.agents/\n.claude/skills\n');
    const skill = installSkill(root, 'om-demo');
    const wt = await createWorktree(root, 'run-isolated', 'main');
    await copyProjectSkills(wt.path, [skill]);

    for (const mirror of ['.agents/skills', '.claude/skills']) {
      expect(lstatSync(join(wt.path, mirror, 'om-demo')).isSymbolicLink()).toBe(false);
      writeFileSync(join(wt.path, mirror, 'om-demo/SKILL.md'), 'edited by the agent\n');
      writeFileSync(join(wt.path, mirror, 'om-demo/references/ref.md'), 'edited\n');
    }

    expect(readFileSync(skill.path, 'utf8')).toBe('---\nname: om-demo\n---\nbody\n');
    expect(readFileSync(join(root, '.agents/skills/om-demo/references/ref.md'), 'utf8')).toBe('ref\n');
  });

  it('refreshes a copy whose source changed, and keeps one the agent edited after copying', async () => {
    const root = repo('.agents/\n.claude/skills\n');
    const skill = installSkill(root, 'om-demo');
    const past = new Date(Date.now() - 60_000);
    utimesSync(skill.path, past, past);
    const wt = await createWorktree(root, 'run-refresh', 'main');
    await copyProjectSkills(wt.path, [skill]);

    writeFileSync(join(wt.path, '.claude/skills/om-demo/SKILL.md'), '---\nname: om-demo\n---\nagent edit\n');
    writeFileSync(skill.path, '---\nname: om-demo\n---\nupdated upstream\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(skill.path, future, future);

    expect(await copyProjectSkills(wt.path, [skill])).toEqual(['.agents/skills/om-demo', '.claude/skills/om-demo']);
    expect(readFileSync(join(wt.path, '.agents/skills/om-demo/SKILL.md'), 'utf8')).toContain('updated upstream');

    writeFileSync(join(wt.path, '.agents/skills/om-demo/SKILL.md'), '---\nname: om-demo\n---\nagent edit\n');
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(wt.path, '.agents/skills/om-demo/SKILL.md'), later, later);
    expect(await copyProjectSkills(wt.path, [skill])).toEqual([]);
    expect(readFileSync(join(wt.path, '.agents/skills/om-demo/SKILL.md'), 'utf8')).toContain('agent edit');
  });

  it('copies only project directory skills', async () => {
    const root = repo('.agents/\n.claude/skills\n');
    const wt = await createWorktree(root, 'run-sources', 'main');
    const skills: Skill[] = [
      { name: 'flat', body: '', path: join(root, '.ai/skills/flat.md'), source: 'ai' },
      { name: 'global', body: '', path: '/home/u/.claude/skills/global/SKILL.md', source: 'global' },
      { name: 'team', body: '', path: 'o/r@main:team/SKILL.md', source: 'team' },
      { name: '../escape', body: '', path: join(root, '.agents/skills/x/SKILL.md'), source: 'agents' },
    ];

    expect(await copyProjectSkills(wt.path, skills)).toEqual([]);
  });
});
