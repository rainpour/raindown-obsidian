// node run.js ruby.wasm workdir script.rb: runs Ruby in WebAssembly under Node's WASI, as V8 runs the plugin's.
const fs = require('node:fs');
const { WASI } = require('node:wasi');
const [ruby, dir, script] = process.argv.slice(2);
(async () => {
  const wasi = new WASI({ version: 'preview1', args: ['ruby', '--disable-gems', `/work/${script}`], preopens: { '/work': dir }, env: {}, returnOnExit: true });
  const module = await WebAssembly.compile(fs.readFileSync(ruby));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  const code = wasi.start(instance);
  if (code) process.exitCode = code;
})().catch((error) => { console.error(error); process.exitCode = 1; });
