import { cargoCommand, run } from './native-runtime.mjs';
try { await run(cargoCommand(), ['test', '--locked', '--manifest-path', 'native/Cargo.toml']); }
catch (error) { console.error(error.message); process.exitCode = 1; }
