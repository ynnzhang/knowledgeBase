import { access } from 'node:fs/promises';
import { projectRoot, notesRoot, localApiPort, usesDefaultNotesRoot } from './local-config.mjs';
import { cargoCommand, run } from './native-runtime.mjs';
import { supervise } from './production-supervisor.mjs';
try {
  try { await access('dist/native-ui/index.html'); } catch { await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.native.config.ts']); }
  await run(cargoCommand(), ['build', '--locked', '--manifest-path', 'native/Cargo.toml']);
  const runtime = supervise([
    { name: 'rust', stdinShutdown: true, command: `./native/target/debug/zhixu${process.platform === 'win32' ? '.exe' : ''}`, args: ['--supervised', '--project', projectRoot, '--notes', notesRoot, '--port', String(localApiPort), ...(usesDefaultNotesRoot ? ['--create'] : [])] },
    { name: 'ui', args: ['node_modules/vite/bin/vite.js', '--config', 'vite.native.config.ts'] },
  ], { cwd: projectRoot, env: { ...process.env, ZHIXU_NODE: process.execPath }, maxRestarts: 0 });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => void runtime.stop());
  process.exitCode = await runtime.completion;
} catch (error) { console.error(error.message); process.exitCode = 1; }
