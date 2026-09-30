import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import {
  expandRegistrySlashSkill,
  expandRegistrySlashSkillText,
  skillDelivery,
  skillSystemPrompt,
} from './run.ts';

describe('skillSystemPrompt — installed-path hint for worktree agents', () => {
  const base = { name: 'om-code-review', description: 'Review a diff.', body: 'Do the review.' };

  it('points an on-disk skill at its absolute installed directory', () => {
    const out = skillSystemPrompt({
      ...base,
      source: 'agents',
      path: '/home/u/Projects/app/.agents/skills/om-code-review/SKILL.md',
    });
    expect(out).toContain('Skill files are installed on disk at: /home/u/Projects/app/.agents/skills/om-code-review');
    expect(out).toContain('references/*.md');
    // Body still present and last.
    expect(out.trimEnd().endsWith('Do the review.')).toBe(true);
  });

  it('omits the path hint for team skills (they are materialized separately)', () => {
    const out = skillSystemPrompt({ ...base, source: 'team', path: '/cache/whatever/SKILL.md' });
    expect(out).not.toContain('installed on disk at');
  });

  it('omits the path hint when no path/source is known', () => {
    const out = skillSystemPrompt(base);
    expect(out).not.toContain('installed on disk at');
  });
});

describe('expandRegistrySlashSkill — live chat delivery', () => {
  const skill = {
    name: 'om-code-review',
    description: 'Review a diff.',
    body: 'Do the review.',
    path: '/home/u/.agents/skills/om-code-review/SKILL.md',
    source: 'global' as const,
  };

  it('replaces a matching leading slash skill with the canonical selected-skill prompt', () => {
    const content: ContentBlock[] = [{ type: 'text', text: '/om-code-review PR 42' }];

    const expanded = expandRegistrySlashSkill(content, [skill]);

    expect(expanded).not.toBe(content);
    expect(expanded[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('Selected skill: /om-code-review'),
    });
    expect((expanded[0] as Extract<ContentBlock, { type: 'text' }>).text).toContain(
      'Skill instructions:\nDo the review.\n\nUser request:\nPR 42',
    );
    expect(content[0]).toEqual({ type: 'text', text: '/om-code-review PR 42' });
  });

  it.each(['/unknown PR 42', ' /om-code-review PR 42', '/om-code-reviewer PR 42'])(
    'leaves non-matching text unchanged: %s',
    (text) => {
      const content: ContentBlock[] = [{ type: 'text', text }];
      expect(expandRegistrySlashSkill(content, [skill])).toBe(content);
    },
  );

  it('preserves image blocks while expanding the first text block', () => {
    const image: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
    };
    const expanded = expandRegistrySlashSkill([image, { type: 'text', text: '/om-code-review' }], [skill]);

    expect(expanded[0]).toBe(image);
    expect((expanded[1] as Extract<ContentBlock, { type: 'text' }>).text).toContain('Do the review.');
  });

  /**
   * #811 — a continuation's opening message becomes the session's `userPrompt` and
   * never passes through `deliverMessage`, so the string form is the seam that path
   * needs. Both spellings must agree, or `/skill` would expand on a live follow-up and
   * leak verbatim on the Reply-after-finish that opens the same session.
   */
  describe('expandRegistrySlashSkillText — the continuation seam (#811)', () => {
    it('expands the same way the content-block form does', () => {
      const text = '/om-code-review PR 42';
      const viaText = expandRegistrySlashSkillText(text, [skill]);
      const viaBlocks = expandRegistrySlashSkill([{ type: 'text', text }], [skill]);

      expect(viaText).toContain('Selected skill: /om-code-review');
      expect(viaText).toContain('Skill instructions:\nDo the review.\n\nUser request:\nPR 42');
      expect((viaBlocks[0] as Extract<ContentBlock, { type: 'text' }>).text).toBe(viaText);
    });

    it('expands a bare skill name with no trailing request', () => {
      expect(expandRegistrySlashSkillText('/om-code-review', [skill])).toBe(skillSystemPrompt(skill));
    });

    it.each(['/unknown PR 42', ' /om-code-review PR 42', '/om-code-reviewer PR 42', 'Continue.'])(
      'returns non-matching text unchanged so a backend keeps its own slash commands: %s',
      (text) => {
        expect(expandRegistrySlashSkillText(text, [skill])).toBe(text);
      },
    );

    it('returns the text unchanged against an empty registry (the #811 failure mode)', () => {
      expect(expandRegistrySlashSkillText('/om-code-review PR 42', [])).toBe('/om-code-review PR 42');
    });
  });
});

describe('skillDelivery — which skills travel as a path', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const cwdWith = (rel?: string): string => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-skill-delivery-'));
    dirs.push(cwd);
    if (rel) {
      mkdirSync(join(cwd, rel), { recursive: true });
      writeFileSync(join(cwd, rel, 'SKILL.md'), 'body');
    }
    return cwd;
  };
  const dirSkill = { name: 'om-code-review', path: '/main/.agents/skills/om-code-review/SKILL.md', source: 'agents' as const };

  it('names the copy inside the worktree when there is one, with nothing to grant', () => {
    const cwd = cwdWith();
    mkdirSync(join(cwd, '.agents/skills/om-code-review'), { recursive: true });
    writeFileSync(join(cwd, '.agents/skills/om-code-review/SKILL.md'), '---\nname: om-code-review\n---\nbody');
    expect(skillDelivery(dirSkill, 'claude', cwd)).toEqual({
      mode: 'path',
      file: join(cwd, '.agents/skills/om-code-review/SKILL.md'),
    });
  });

  it('never names a worktree skill in that directory that declares another name', () => {
    const cwd = cwdWith();
    mkdirSync(join(cwd, '.agents/skills/om-code-review'), { recursive: true });
    writeFileSync(join(cwd, '.agents/skills/om-code-review/SKILL.md'), '---\nname: another-skill\n---\nbody');
    expect(skillDelivery(dirSkill, 'claude', cwd)).toEqual({
      mode: 'path',
      file: dirSkill.path,
      grant: '/main/.agents/skills/om-code-review',
    });
  });

  it('names the installed copy and grants its directory when the worktree has none', () => {
    expect(skillDelivery(dirSkill, 'codex', cwdWith())).toEqual({
      mode: 'path',
      file: dirSkill.path,
      grant: '/main/.agents/skills/om-code-review',
    });
  });

  it.each(['claude', 'claude-cli', 'codex', 'opencode'] as const)('uses the path on %s', (backend) => {
    expect(skillDelivery(dirSkill, backend, cwdWith()).mode).toBe('path');
  });

  it('inlines on a backend whose native skill loading is not verified', () => {
    expect(skillDelivery(dirSkill, 'pi', cwdWith())).toEqual({ mode: 'inline' });
  });

  it('inlines a single-file skill and the built-in skill', () => {
    const cwd = cwdWith();
    expect(skillDelivery({ name: 'flat', path: '/main/.ai/skills/flat.md', source: 'ai' }, 'claude', cwd)).toEqual({ mode: 'inline' });
    expect(skillDelivery({ name: 'b', path: 'builtin:b', source: 'builtin' }, 'claude', cwd)).toEqual({ mode: 'inline' });
  });

  it('uses a materialized team skill, and inlines one that was not materialized', () => {
    const team = { name: 'team-skill', path: 'o/r@main:team-skill/SKILL.md', source: 'team' as const };
    const cwd = cwdWith('.claude/skills/team-skill');
    expect(skillDelivery(team, 'claude', cwd)).toEqual({
      mode: 'path',
      file: join(cwd, '.claude/skills/team-skill/SKILL.md'),
    });
    expect(skillDelivery(team, 'claude', cwdWith())).toEqual({ mode: 'inline' });
  });
});

describe('skillSystemPrompt — path delivery', () => {
  const skill = { name: 'om-code-review', description: 'Review a diff.', body: 'Do the review.', source: 'agents' as const, path: '/p/SKILL.md' };

  it('carries identity, the file and the load instruction, but not the body', () => {
    const out = skillSystemPrompt(skill, { mode: 'path', file: '/wt/.agents/skills/om-code-review/SKILL.md' });
    expect(out).toContain('Selected skill: /om-code-review');
    expect(out).toContain('Description: Review a diff.');
    expect(out).toContain('Skill file: /wt/.agents/skills/om-code-review/SKILL.md');
    expect(out).toContain('skill tool');
    expect(out).not.toContain('Do the review.');
  });

  it('keeps the inlined body by default', () => {
    expect(skillSystemPrompt(skill)).toContain('Skill instructions:\nDo the review.');
  });
});

describe('expandRegistrySlashSkillText — step skill dedupe and backend-aware delivery', () => {
  const skill = {
    name: 'om-code-review',
    description: 'Review a diff.',
    body: 'Do the review.',
    path: '/main/.agents/skills/om-code-review/SKILL.md',
    source: 'agents' as const,
  };

  it('keeps only the request when the step already selects the same skill', () => {
    expect(expandRegistrySlashSkillText('/om-code-review PR 42', [skill], { stepSkill: 'om-code-review' })).toBe('PR 42');
  });

  it('turns a request-less duplicate into an instruction instead of an empty prompt', () => {
    expect(expandRegistrySlashSkillText('/om-code-review', [skill], { stepSkill: 'om-code-review' })).toBe(
      'Follow the selected skill /om-code-review.',
    );
  });

  it('still expands a different skill than the step selects', () => {
    expect(expandRegistrySlashSkillText('/om-code-review PR 42', [skill], { stepSkill: 'other' })).toContain(
      'Skill instructions:\nDo the review.',
    );
  });

  it('names the file instead of the body when the backend loads skills natively', () => {
    const out = expandRegistrySlashSkillText('/om-code-review PR 42', [skill], { backend: 'claude', cwd: '/nowhere' });
    expect(out).toContain(`Skill file: ${skill.path}`);
    expect(out).not.toContain('Do the review.');
    expect(out.endsWith('User request:\nPR 42')).toBe(true);
  });
});
