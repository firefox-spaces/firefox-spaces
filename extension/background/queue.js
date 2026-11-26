// Every state-changing piece of work (browser events, sidebar commands) runs through one
// serial queue, so handlers never interleave and see a consistent model.

// Errors meant for the user (shown in the sidebar), not bugs worth logging.
export class UserError extends Error {}

let chain = Promise.resolve();
let afterTask = () => {};

export function setAfterTask(fn) {
  afterTask = fn;
}

// A task that holds the queue this long is a problem worth knowing about: everything
// else (events, sidebar commands, container checks) waits in line behind it.
const SLOW_TASK_MS = 500;

export function enqueue(fn, label) {
  const run = chain.then(async () => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      const ms = Date.now() - t0;
      if (ms > SLOW_TASK_MS) console.warn(`[Spaces] slow task${label ? ` (${label})` : ''}: ${ms}ms`);
    }
  });
  chain = run.then(
    () => afterTask(label),
    (err) => {
      if (!(err instanceof UserError)) console.error('[Spaces]', err);
      afterTask(label);
    },
  );
  return run;
}

// Fire-and-forget variant for event listeners (errors are already logged above).
//
// Watchdog: browser events feeding handlers that themselves open/close/move tabs can form
// a feedback loop (with another extension, a browser setting, or a bug here). A runaway
// loop produces thousands of events per second; legitimate use (even restoring a large
// session) stays far below STORM_MAX per window. When tripped, event handling is suspended
// so Firefox stays usable — the model may go stale until the next restart, which is the
// lesser evil.
const STORM_WINDOW_MS = 10_000;
const STORM_MAX = 1000;
let stormStamps = [];
let suspendedUntil = 0;

export function fire(fn, label) {
  const now = Date.now();
  if (now < suspendedUntil) return;
  stormStamps.push(now);
  if (stormStamps.length > STORM_MAX) {
    stormStamps = stormStamps.filter((t) => now - t < STORM_WINDOW_MS);
    if (stormStamps.length > STORM_MAX) {
      suspendedUntil = now + 60_000;
      stormStamps = [];
      console.error(`[Spaces] EVENT STORM: over ${STORM_MAX} browser events in ${STORM_WINDOW_MS / 1000}s — `
        + 'suspending all event handling for 60s. Something (another extension, a container setting, '
        + 'or a Spaces bug) is fighting over tabs. Please report what the Browser Console shows.');
      return;
    }
  }
  enqueue(fn, label).catch(() => {});
}
