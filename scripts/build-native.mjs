import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './local-config.mjs';
import { cargoCommand, run, sourceFingerprint } from './native-runtime.mjs';
try {
  await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.native.config.ts']);
  await run(cargoCommand(), ['build', '--release', '--locked', '--manifest-path', 'native/Cargo.toml']);
  await mkdir(path.join(projectRoot, 'native/target'), { recursive: true });
  await writeFile(path.join(projectRoot, 'native/target/source.sha256'), await sourceFingerprint());
} catch (error) { console.error(error.message); process.exitCode = 1; }
