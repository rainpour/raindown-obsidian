'use strict';

// Ruby without Asyncify, from build.sh's eh, with its _start called through WebAssembly.promising, so its Fibers switch
// with JSPI, with rb_wasm_jspi's imports, as the worker gives them, and ruby.wasm's WASI, from bin/build's download of
// its browser bundle, with the files in a folder at /work, and what it printed:
//   node run-jspi.js ruby.wasm bench hash.rb
const fs = require('node:fs');
const path = require('node:path');
const bundle = path.join(__dirname, '../../../build/runtime/npm-4.0/package/dist/browser.umd.js');
const exported = 'exports.DefaultRubyVM = DefaultRubyVM;';
const scope = {};
new Function('self', 'globalThis', fs.readFileSync(bundle, 'utf8').replace(exported, `${exported} Object.assign(exports, { WASI, OpenFile, File, PreopenDirectory });`))(scope, scope);
const { WASI, OpenFile, File, PreopenDirectory } = scope['ruby-wasm-wasi'];
const [ruby, dir, script] = process.argv.slice(2);

// Fibers as JSPI stacks: a switch suspends the stack until something switches back, and resumes or starts the target.
function jspiImports(exports) {
  const suspended = new Map();
  return {
    switch: new WebAssembly.Suspending((from, to, start) => {
      const back = new Promise((resolve) => suspended.set(from, resolve));
      queueMicrotask(() => {
        if (start) exports.fiberStart(to).catch((error) => console.error('Fiber failed', error));
        else { const resume = suspended.get(to); suspended.delete(to); resume(); }
      });
      return back;
    }),
    await: new WebAssembly.Suspending(async () => 0)
  };
}

(async () => {
  const files = new Map(fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, new File(fs.readFileSync(path.join(dir, f)))]));
  const stdout = new File([]); const stderr = new File([]);
  const wasi = new WASI(['ruby', '--disable-gems', `/work/${script}`], [], [new OpenFile(new File([])), new OpenFile(stdout), new OpenFile(stderr), new PreopenDirectory('/work', files)], { debug: false });
  const exports = {};
  const module = await WebAssembly.compile(fs.readFileSync(ruby));
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport, rb_wasm_jspi: jspiImports(exports) });
  exports.fiberStart = WebAssembly.promising(instance.exports.rb_wasm_jspi_fiber_start);
  wasi.inst = instance;
  const started = performance.now();
  try { await WebAssembly.promising(instance.exports._start)(); } catch (e) { if (!String(e).includes('exit')) console.error(e); }
  process.stdout.write(new TextDecoder().decode(stdout.data)); process.stderr.write(new TextDecoder().decode(stderr.data));
  console.error(`(${(performance.now() - started).toFixed(0)} ms)`);
})();
