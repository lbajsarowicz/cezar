import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '../core/agent-runner.ts';
import { CursorAgentRunner } from '../core/cursor-agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { MISSING_SESSION_NOTE } from './resume-fallback.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_CODEX = join(HERE, '..', 'core', '__fixtures__', 'codex', 'mock-codex-app-server.mjs');
const MOCK_OPENCODE = join(HERE, '..', 'core', '__fixtures__', 'opencode', 'mock-opencode-serve.mjs');
const TASK = 'make the verify check pass';

/** The check fails on its first run and passes on every later one. */
const WORKFLOW: WorkflowDef = {
  name: 'implement-verify',
  source: 'file',
  steps: [
    { id: 'implement', prompt: '{{task}}' },
    { id: 'verify', command: 'test -f .verified || { touch .verified; echo "1 test failed"; exit 1; }', onFail: { retry: 'implement', max: 1 } },
  ],
};

describe('onFail.retry resumes the retried step instead of restarting it', () => {
  let repoRoot: string;
  let turnsFile: string;
  let store: RunStore;
  let manager: RunManager;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string | undefined): void => {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retry-resume-'));
    turnsFile = join(repoRoot, '..', `${basename(repoRoot)}-turns.ndjson`);
    setEnv('CEZ_CODEX_BIN', MOCK_CODEX);
    setEnv('CEZ_AUTONAME', '0');
    setEnv('MOCK_CODEX_TURNS_FILE', turnsFile);
    setEnv('CEZ_MOCK_MISSING_SESSIONS', undefined);
    setEnv('MOCK_CODEX_REJECT_RESUME', undefined);
    setEnv('CEZ_ENV_PASSTHROUGH', 'MOCK_CODEX_TURNS_FILE,MOCK_CODEX_REJECT_RESUME');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, '.gitignore'), '.verified\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(turnsFile, { force: true });
  });

  async function runToEnd(runner: 'codex' | 'opencode' = 'codex'): Promise<string> {
    const record = manager.startRun(WORKFLOW, { task: TASK, runner, worktree: false });
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    return record.id;
  }

  const turns = (): string[] =>
    readFileSync(turnsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string);

  it('sends only the failure into the session the first attempt left', async () => {
    const id = await runToEnd();
    expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
      ['implement', 'done'],
      ['verify', 'done'],
    ]);

    const [first, retry] = turns();
    expect(turns()).toHaveLength(2);
    expect(first).toContain(TASK);
    expect(retry).toContain('A verification command failed after the previous attempt');
    expect(retry).toContain('1 test failed');
    // Neither the task nor the system prompt is paid for a second time.
    expect(retry).not.toContain(TASK);
    expect(retry).not.toContain('## Handoff (cezar)');
    expect(store.getRun(id)?.steps.find((s) => s.id === 'implement')?.sessionId).toBe('th_mock_1');
    expect(store.readEvents(id).some((e) => e.type === 'note' && String(e.message).includes("previous session — sending only the failure"))).toBe(true);
  }, 30_000);

  it('falls back to a fresh session carrying the whole task when codex no longer has the thread', async () => {
    setEnv('MOCK_CODEX_REJECT_RESUME', '1');
    const id = await runToEnd();
    expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
      ['implement', 'done'],
      ['verify', 'done'],
    ]);

    // The rejected resume never starts a turn: the first attempt, then the fresh fallback.
    const all = turns();
    expect(all).toHaveLength(2);
    expect(all[1]).toContain(TASK);
    expect(all[1]).toContain('## Handoff (cezar)');
    expect(all[1]).toContain('1 test failed');
    expect(store.readEvents(id).some((e) => e.type === 'note' && e.message === MISSING_SESSION_NOTE)).toBe(true);
    expect(store.readEvents(id).some((e) => e.type === 'error' && e.stepId === 'implement')).toBe(false);
  }, 30_000);

  it('keeps the run token totals when the codex resume falls back', async () => {
    setEnv('MOCK_CODEX_REJECT_RESUME', '1');
    const id = await runToEnd();
    const record = store.getRun(id);
    const step = record?.steps.find((s) => s.id === 'implement');
    expect(step?.usageInvocationsStarted).toBe(step?.usageInvocationsObserved);
    expect(record?.inputTokens).toBe(2400);
    expect(record?.outputTokens).toBe(600);
  }, 30_000);

  it('falls back to a fresh session when opencode answers the resume with a 404', async () => {
    const promptsFile = join(repoRoot, '..', `${basename(repoRoot)}-opencode-prompts.ndjson`);
    setEnv('CEZ_OPENCODE_BIN', MOCK_OPENCODE);
    setEnv('MOCK_OPENCODE_PROMPTS_FILE', promptsFile);
    setEnv('MOCK_OPENCODE_SESSIONS_GONE', '1');
    setEnv('CEZ_ENV_PASSTHROUGH', 'MOCK_OPENCODE_PROMPTS_FILE,MOCK_OPENCODE_SESSIONS_GONE');
    try {
      const id = await runToEnd('opencode');
      expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
        ['implement', 'done'],
        ['verify', 'done'],
      ]);
      const prompts = readFileSync(promptsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(TASK);
      expect(prompts[1]).toContain('1 test failed');
      expect(store.readEvents(id).some((e) => e.type === 'note' && e.message === MISSING_SESSION_NOTE)).toBe(true);
    } finally {
      rmSync(promptsFile, { force: true });
    }
  }, 30_000);

  it('does not resume a strict backend under a different account', async () => {
    const seam = manager as unknown as {
      agentEnvForStep: (runId: string, backend: string, options?: { recordedProfileId?: string }) => Promise<{ env: Record<string, string>; profileId: string }>;
    };
    const real = seam.agentEnvForStep.bind(manager);
    let calls = 0;
    const spy = vi.spyOn(seam, 'agentEnvForStep').mockImplementation(async (runId, backend, options) => {
      const resolved = await real(runId, backend, options);
      calls += 1;
      return { ...resolved, profileId: calls === 1 ? 'work' : 'personal' };
    });
    try {
      const id = await runToEnd();
      const all = turns();
      expect(all).toHaveLength(2);
      // The previous attempt recorded `work`; the retry resolved to another account, so it must
      // run the whole task in a fresh session rather than reopen the wrong account's session.
      expect(all[1]).toContain(TASK);
      expect(all[1]).toContain('## Handoff (cezar)');
      expect(store.readEvents(id).some((e) => e.type === 'note' && String(e.message).includes('sending only the failure'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  describe('on claude', () => {
    const claudeWorkflow = (marker: string): WorkflowDef => ({
      ...WORKFLOW,
      steps: [
        WORKFLOW.steps[0]!,
        { id: 'verify', command: `test -f .verified || { touch .verified; echo "1 test failed ${marker}"; exit 1; }`, onFail: { retry: 'implement', max: 1 } },
      ],
    });

    interface ClaudeRun {
      id: string;
      argv: string[][];
      prompts: string[];
    }

    async function runClaude(marker: string, options: { onFirstSession?: (id: string) => void } = {}): Promise<ClaudeRun> {
      const argsFile = join(repoRoot, '..', `${basename(repoRoot)}-args.ndjson`);
      const stdinFile = join(repoRoot, '..', `${basename(repoRoot)}-stdin.ndjson`);
      setEnv('CEZ_DRY_RUN', '1');
      setEnv('CEZ_MOCK_ARGS_FILE', argsFile);
      setEnv('CEZ_MOCK_STDIN_FILE', stdinFile);
      try {
        const record = manager.startRun(claudeWorkflow(marker), { task: TASK, runner: 'claude', worktree: false });
        const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
        const deadline = Date.now() + 25_000;
        if (options.onFirstSession) {
          while (!store.getRun(record.id)?.steps.find((s) => s.id === 'implement')?.sessionId) {
            if (Date.now() > deadline) throw new Error('the first attempt never started');
            await new Promise((r) => setTimeout(r, 5));
          }
          options.onFirstSession(record.id);
        }
        while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
          if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
        return {
          id: record.id,
          argv: lines(argsFile) as string[][],
          prompts: (lines(stdinFile) as { userText: string }[]).map((entry) => entry.userText),
        };
      } finally {
        rmSync(argsFile, { force: true });
        rmSync(stdinFile, { force: true });
      }
    }

    const notesOf = (id: string): string[] =>
      store.readEvents(id).filter((e) => e.type === 'note').map((e) => String(e.message));

    it('resumes the session the first attempt pinned and sends it only the failure', async () => {
      const { id, argv, prompts } = await runClaude('mock:plain');
      expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
        ['implement', 'done'],
        ['verify', 'done'],
      ]);
      expect(argv).toHaveLength(2);
      const [first, resumed] = argv;
      expect(resumed).toContain('--resume');
      expect(resumed![resumed!.indexOf('--resume') + 1]).toBe(first![first!.indexOf('--session-id') + 1]);
      expect(prompts[1]).toContain('1 test failed');
      expect(prompts[1]).not.toContain(TASK);
      expect(notesOf(id).some((m) => m.includes('sending only the failure'))).toBe(true);
    }, 30_000);

    it.each([
      ['the CLI reports it on stderr', () => setEnv('CEZ_MOCK_MISSING_SESSIONS', '*'), 'mock:plain'],
      ['the CLI reports it only in the result frame `errors`', () => undefined, 'mock:session-gone'],
    ])('a pruned conversation on retry goes through the missing-session fallback when %s', async (_label, arm, marker) => {
      arm();
      const { id, argv, prompts } = await runClaude(marker);
      expect(store.getRun(id)?.steps.map((s) => [s.id, s.status])).toEqual([
        ['implement', 'done'],
        ['verify', 'done'],
      ]);
      expect(argv).toHaveLength(3);
      const [first, resumed, fresh] = argv;
      expect(first).toContain('--session-id');
      expect(resumed).toContain('--resume');
      expect(resumed![resumed!.indexOf('--resume') + 1]).toBe(first![first!.indexOf('--session-id') + 1]);
      expect(fresh).toContain('--session-id');
      expect(fresh).not.toContain('--resume');
      // The fresh session runs the step's whole prompt: the task and the failure.
      const freshPrompt = prompts.at(-1)!;
      expect(freshPrompt).toContain(TASK);
      expect(freshPrompt).toContain('1 test failed');
      expect(notesOf(id)).toContain(MISSING_SESSION_NOTE);
      const implement = store.getRun(id)?.steps.find((s) => s.id === 'implement');
      expect(implement?.sessionId).toBe(fresh![fresh!.indexOf('--session-id') + 1]);
      // The dead resume's bookkeeping was dropped, so the run's token totals stay consistent.
      expect(implement?.usageInvocationsStarted).toBe(implement?.usageInvocationsObserved);
      expect(store.getRun(id)?.inputTokens).toBeGreaterThan(0);
    }, 30_000);

    it('carries the reports the dead resume had flushed into the fresh session', async () => {
      setEnv('CEZ_MOCK_MISSING_SESSIONS', '*');
      const pending = {
        fromRunId: 'child_run_1',
        title: 'Auth check',
        report: { status: 'done' as const, result: 'auth refactor finished', evidence: [], side_effects: [], errors: [], suggestions: [] },
        at: '2026-09-30T00:00:00.000Z',
      };
      // The first attempt flushes pending reports before it is given a session id; seeding after
      // that leaves one for the retry to flush, which the fresh fallback must then carry.
      const { prompts } = await runClaude('mock:plain', {
        onFirstSession: (id) => store.updateRun(id, { dispatch: { rootRunId: id, pendingReports: [pending] } }),
      });
      const freshPrompt = prompts.at(-1)!;
      expect(freshPrompt).toContain('auth refactor finished');
      expect(freshPrompt).toContain('Reports from your dispatched tasks');
    }, 30_000);

    it('does not restart when the resumed session fails with a usage limit', async () => {
      const { id, argv } = await runClaude('mock:resume-limit');
      // A usage limit is not a missing conversation: the retry must fail on the limit rather than
      // pay for a whole fresh prompt that would hit the same limit.
      expect(store.getRun(id)?.status).toBe('failed');
      expect(argv).toHaveLength(2);
      expect(argv[1]).toContain('--resume');
      expect(notesOf(id)).not.toContain(MISSING_SESSION_NOTE);
    }, 30_000);

    it('does not restart a session that reopened and then failed mid-turn', async () => {
      const { id, argv } = await runClaude('mock:resume-mid-fail');
      expect(store.getRun(id)?.status).toBe('failed');
      expect(argv).toHaveLength(2);
      expect(argv[1]).toContain('--resume');
      expect(notesOf(id)).not.toContain(MISSING_SESSION_NOTE);
    }, 30_000);
  });
  describe('on cursor', () => {
    // Cursor print mode has no verified resume, so a retry must stay a fresh session that is
    // sent the whole task again — never a failure-only prompt into a chat that may be blank.
    it('retries in a fresh session carrying the whole task', async () => {
      const cursorRunner: AgentRunner = new CursorAgentRunner();
      expect(cursorRunner.strictResume).toBeUndefined();
      const argsFile = join(repoRoot, '..', `${basename(repoRoot)}-cursor-args.ndjson`);
      setEnv('CEZ_DRY_RUN', '1');
      setEnv('CEZ_MOCK_ARGS_FILE', argsFile);
      try {
        const record = manager.startRun(WORKFLOW, { task: TASK, runner: 'cursor', worktree: false });
        const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
        const deadline = Date.now() + 25_000;
        while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
          if (Date.now() > deadline) throw new Error(`run did not finish: ${store.getRun(record.id)?.status}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(store.getRun(record.id)?.steps.map((s) => [s.id, s.status])).toEqual([
          ['implement', 'done'],
          ['verify', 'done'],
        ]);
        const argv = readFileSync(argsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(argv).toHaveLength(2);
        const retry = argv[1]!;
        expect(retry).not.toContain('--resume');
        expect(retry.at(-1)).toContain(TASK);
        expect(retry.at(-1)).toContain('## Handoff (cezar)');
        expect(retry.at(-1)).toContain('1 test failed');
        const notes = store.readEvents(record.id).filter((e) => e.type === 'note').map((e) => String(e.message));
        expect(notes.some((m) => m.includes('sending only the failure'))).toBe(false);
      } finally {
        rmSync(argsFile, { force: true });
      }
    }, 30_000);
  });
});
