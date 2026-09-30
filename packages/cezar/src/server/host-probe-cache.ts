/**
 * Stale-while-revalidate holder for host facts that change on a human timescale — which agent
 * CLIs are installed, `gh` auth, the repo's root and remote — so a reader on a seconds-long
 * cadence (the health tick) gets them without spawning anything. Same posture as
 * `ProviderAuthService.status`: a cold cache waits, a warm one answers immediately and an
 * expired one is refreshed BEHIND the answer. `invalidate` is for an explicit "check again":
 * the next read waits for a fresh compute.
 */
export interface HostProbeCache<T> {
  get(): Promise<T>;
  /** Adopt a compute already running elsewhere (the boot probe) instead of starting a second. */
  seed(pending: Promise<T>): void;
  invalidate(): void;
}

export function createHostProbeCache<T>(
  compute: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): HostProbeCache<T> {
  let completed: { at: number; value: T } | undefined;
  let inFlight: Promise<T> | undefined;
  let generation = 0;

  const track = (pending: Promise<T>): Promise<T> => {
    const mine = ++generation;
    const settled = pending.then(
      (value) => {
        if (mine === generation) {
          completed = { at: now(), value };
          inFlight = undefined;
        }
        return value;
      },
      (err: unknown) => {
        if (mine === generation) inFlight = undefined;
        throw err;
      },
    );
    inFlight = settled;
    return settled;
  };

  return {
    get() {
      if (completed) {
        if (now() - completed.at >= ttlMs && !inFlight) void track(compute()).catch(() => {});
        return Promise.resolve(completed.value);
      }
      return inFlight ?? track(compute());
    },
    seed(pending) {
      if (completed || inFlight) return;
      void track(pending).catch(() => {});
    },
    invalidate() {
      completed = undefined;
      inFlight = undefined;
      generation++;
    },
  };
}

/** The same seam with no cache: every read computes. For callers with no tick to amortize over. */
export function passthroughProbe<T>(compute: () => Promise<T>): HostProbeCache<T> {
  return { get: compute, seed: () => {}, invalidate: () => {} };
}
