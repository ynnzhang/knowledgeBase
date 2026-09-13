import { spawn } from 'node:child_process';
import { stopProcessTree } from './local-platform.mjs';

// Each service has an independent restart budget. Stop the entire release if a
// service cannot recover, so an OS service manager can report/restart it.
export function supervise(services, { cwd, env = process.env, maxRestarts = 5, baseDelay = 1000, stableMs = 60_000, probeInterval = 5000, probeGraceMs = 60_000, log = console.log } = {}) {
  let stopping = false;
  let finish;
  const completion = new Promise((resolve) => { finish = resolve; });
  const states = services.map((service) => ({ ...service, child: null, timer: null, probeTimer: null, failures: 0, attempts: 0, started: 0, probing: false, healthySince: 0 }));
  const emit = (event, state, detail = {}) => log(JSON.stringify({ time: new Date().toISOString(), event, service: state?.name, ...detail }));
  async function stop(code = 0) {
    if (stopping) return completion;
    stopping = true;
    const exits = states.map((state) => {
      clearTimeout(state.timer); clearInterval(state.probeTimer);
      const child = state.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { stopProcessTree(child.pid); }, 10_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        // Our notes worker drains requests on IPC on both Windows and macOS.
        if (state.stdinShutdown && child.stdin) child.stdin.end('shutdown\n');
        else if (state.ipc && child.connected) child.send('shutdown', () => {});
        else child.kill('SIGTERM');
      });
    });
    await Promise.all(exits);
    emit('stopped', null, { code });
    finish(code);
    return completion;
  }
  function launch(state) {
    if (stopping) return;
    state.started = Date.now(); state.failures = 0; state.healthySince = state.healthUrl ? 0 : state.started;
    const child = spawn(state.command || process.execPath, state.args, { cwd, env, stdio: state.ipc ? ['ignore', 'inherit', 'inherit', 'ipc'] : [state.stdinShutdown ? 'pipe' : 'ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32', windowsHide: true });
    state.child = child;
    child.stdin?.on('error', () => {}); // A concurrent child exit may close the control pipe.
    emit('started', state, { pid: child.pid });
    let ended = false;
    const onEnd = (code, signal) => {
      if (ended) return;
      ended = true; state.child = null; clearInterval(state.probeTimer);
      if (stopping) return;
      if (state.healthySince && Date.now() - state.healthySince >= stableMs) state.attempts = 0;
      if (state.attempts >= maxRestarts) {
        emit('restart_exhausted', state, { code, signal });
        void stop(1); return;
      }
      const waitMs = Math.min(baseDelay * 2 ** state.attempts++, 30_000);
      emit('restarting', state, { code, signal, waitMs, attempt: state.attempts });
      state.timer = setTimeout(() => launch(state), waitMs);
    };
    child.once('error', (error) => onEnd(error.code || 'spawn_error', null));
    child.once('exit', onEnd);
    if (state.healthUrl) state.probeTimer = setInterval(async () => {
      if (stopping || ended || state.probing || Date.now() - state.started < probeGraceMs) return;
      state.probing = true;
      try {
        const response = await fetch(state.healthUrl, { signal: AbortSignal.timeout(1500) });
        const result = await response.json();
        if (!response.ok || result.service !== state.healthService) throw new Error('unhealthy');
        state.failures = 0;
        state.healthySince ||= Date.now();
      } catch {
        state.healthySince = 0;
        if (++state.failures >= 3 && !stopping && !ended) {
          // taskkill returns before the Windows process exits. Stop probing
          // this generation so we don't repeatedly launch termination requests.
          clearInterval(state.probeTimer);
          emit('unresponsive', state);
          stopProcessTree(child.pid);
        }
      } finally { state.probing = false; }
    }, probeInterval);
  }
  states.forEach(launch);
  return { stop, completion };
}
