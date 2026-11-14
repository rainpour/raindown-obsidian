'use strict';

// Runs test/ruby/jumps.rb, each of Ruby's jumps through its C, in the module bin/build packed, directly and in a
// Fiber, as the worker answers each request, and natively, in the plugin's Ruby, and fails unless each case's result
// is native Ruby's. So a mistake in wasm/patches, or a ruby.wasm update, that changes how a jump's caught, like an
// ensure that doesn't run, fails the build. bin/build runs it after the smoke test.
//   node scripts/jumps.js build/raindown.wasm build/runtime/npm-4.0/package/dist/browser.umd.js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [wasm, bundle] = process.argv.slice(2);
const SUITE = path.join(__dirname, '..', 'test', 'ruby', 'jumps.rb');
// A stack overflow is only caught in a Fiber, as Ruby checks its stack there, so it's left out of the direct run.
const FIBER_ONLY = /^stack overflow: /;

// ruby.wasm's browser bundle, with RubyVM and the WASI classes, as bin/build adds them for the worker.
function rubyWasm() {
  const exported = 'exports.DefaultRubyVM = DefaultRubyVM;';
  const source = fs.readFileSync(bundle, 'utf8');
  if (!source.includes(exported)) throw new Error("ruby.wasm's browser bundle no longer exports DefaultRubyVM where it did");

  const scope = {};
  new Function('self', 'globalThis', source.replace(exported, `${exported} Object.assign(exports, { RubyVM, WASI, OpenFile, File, PreopenDirectory });`))(scope, scope);
  return scope['ruby-wasm-wasi'];
}

// The suite's lines from a new Ruby in the module, so one run's constants and files aren't the next's.
async function inWasm(module, code, fiber) {
  const { RubyVM, WASI, OpenFile, File, PreopenDirectory } = rubyWasm();
  const wasi = new WASI([], [], [...[0, 1, 2].map(() => new OpenFile(new File([]))), new PreopenDirectory('/', new Map())], { debug: false });
  const { vm } = await RubyVM.instantiateModule({ module, wasip1: wasi, args: ['ruby.wasm', '--disable-gems', '-EUTF-8', '-e_=0'] });
  // As the worker starts Ruby, so files packed as bytecode only are loaded from it.
  vm.eval("require 'rbconfig'\nrequire '/engine/bytecode' if File.exist?('/engine/bytecode.rb')");
  const script = `IN_FIBER = ${fiber}\n${code}`;
  const lines = fiber ? await vm.evalAsync(script) : vm.eval(script);
  return lines.toString().split('\n');
}

function natively() {
  const script = 'IN_FIBER = true; puts eval(File.read(ARGV.fetch(0)))';
  return execFileSync('ruby', ['-e', script, SUITE], { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trimEnd().split('\n');
}

// The cases that aren't native Ruby's, each with what native Ruby gave.
function differences(name, lines, expected) {
  const cases = Math.max(lines.length, expected.length);
  return Array.from({ length: cases }, (_, at) => at).filter((at) => lines[at] !== expected[at])
    .map((at) => `${name}: ${lines[at]}\n  natively: ${expected[at]}`);
}

async function jumps() {
  const code = fs.readFileSync(SUITE, 'utf8');
  const module = await WebAssembly.compile(fs.readFileSync(wasm));
  const expected = natively();
  const failures = [
    ...differences('In a Fiber', await inWasm(module, code, true), expected),
    ...differences('Directly', await inWasm(module, code, false), expected.filter((line) => !FIBER_ONLY.test(line)))
  ];
  if (failures.length) throw new Error(failures.join('\n'));

  console.log(`Jumps: ${expected.length} cases the same in ruby.wasm, directly and in a Fiber, as in native Ruby`);
}

jumps().catch((error) => {
  console.error(`Jumps failed: ${error.message}`);
  process.exitCode = 1;
});
