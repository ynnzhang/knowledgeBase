import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { supervise } from './production-supervisor.mjs';

const waitFor = async (predicate) => { for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(20); } assert.fail('timed out'); };
test('bounded exponential restart, fatal exit stops healthy peers', { timeout: 10000 }, async () => {
  const events = [];
  const runtime = supervise([
    { name: 'crash', args: ['-e', 'process.exit(2)'] },
    { name: 'peer', args: ['-e', 'setInterval(()=>{}, 1000)'] },
  ], { baseDelay: 10, maxRestarts: 2, log: (line) => events.push(JSON.parse(line)) });
  try {
    assert.equal(await runtime.completion, 1);
    assert.deepEqual(events.filter((e) => e.event === 'restarting').map((e) => e.waitMs), [10, 20]);
    assert.equal(events.filter((e) => e.event === 'restart_exhausted').length, 1);
    assert.equal(events.filter((e) => e.service === 'peer' && e.event === 'started').length, 1);
  } finally { await runtime.stop(); }
});

test('explicit shutdown drains IPC worker and cancels pending restarts', { timeout: 10000 }, async () => {
  const events = [];
  const runtime = supervise([
    { name: 'worker', ipc: true, args: ['-e', "process.on('message', m => { if(m === 'shutdown') setTimeout(() => process.disconnect(), 50); });"] },
    { name: 'crash', args: ['-e', 'process.exit(0)'] },
  ], { baseDelay: 5000, log: (line) => events.push(JSON.parse(line)) });
  await waitFor(() => events.some((e) => e.event === 'restarting'));
  await runtime.stop();
  assert.equal(await runtime.completion, 0);
  assert.equal(events.filter((e) => e.service === 'crash' && e.event === 'started').length, 1);
});

test('hung process is killed and uses the same bounded restart budget', { timeout: 10000 }, async () => {
  const events = [];
  const runtime = supervise([{ name: 'hung', args: ['-e', 'setInterval(()=>{}, 1000)'], healthUrl: 'http://127.0.0.1:1/health', healthService: 'test' }], {
    maxRestarts: 1, baseDelay: 1, stableMs: 1, probeGraceMs: 10, probeInterval: 20, log: (line) => events.push(JSON.parse(line)),
  });
  try {
    assert.equal(await runtime.completion, 1);
    assert.equal(events.filter((e) => e.event === 'unresponsive').length, 2);
  } finally { await runtime.stop(); }
});


test('spawn failure exits cleanly instead of waiting forever for a nonexistent child', { timeout: 5000 }, async () => {
  const runtime = supervise([{ name: 'missing', args: ['-e', ''] }], { cwd: '/zhixu-does-not-exist-' + Date.now(), maxRestarts: 0, log: () => {} });
  assert.equal(await runtime.completion, 1);
});
