'use strict';

// Runs test/ruby/jumps.rb, each of Ruby's jumps through its C, in the module bin/build packed, directly and in a
// Fiber, as the worker answers each request, and natively, in the plugin's Ruby, and fails unless each case's result
// is native Ruby's. So a mistake in wasm/patches, or a ruby.wasm update, that changes how a jump's caught, like an
// ensure that doesn't run, fails the build. bin/build runs it after the smoke test.
//   node scripts/jumps.js build/raindown.wasm build/runtime/npm-4.0/package/dist/browser.umd.js build/root
// Ruby's files are build/root's, as main.js has them. A module without Asyncify, which imports rb_wasm_jspi, runs it in
// a Fiber through rb_wasm_jspi_eval, with Node 26's JSPI, rather than evalAsync.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [wasm, bundle, rootFolder] = process.argv.slice(2);
const SUITE = path.join(__dirname, '..', 'test', 'ruby', 'jumps.rb');
// A stack overflow is only caught in a Fiber, as Ruby checks its stack there, so it's left out of the direct run.
const FIBER_ONLY = /^stack overflow: /;

// ruby.wasm's browser bundle, with RubyVM and the WASI classes, as bin/build adds them for the worker.
function rubyWasm() {
  const exported = 'exports.DefaultRubyVM = DefaultRubyVM;';
  const source = fs.readFileSync(bundle, 'utf8');
  if (!source.includes(exported)) throw new Error("ruby.wasm's browser bundle no longer exports DefaultRubyVM where it did");

  const scope = {};
  new Function('self', 'globalThis', source.replace(exported, `${exported} Object.assign(exports, { RubyVM, WASI, OpenFile, File, PreopenDirectory, Directory });`))(scope, scope);
  return scope['ruby-wasm-wasi'];
}

// A folder's files, as the WASI shim's, with their folders.
function folderContents(folder, { File, Directory }) {
  return new Map(fs.readdirSync(folder, { withFileTypes: true }).map((entry) => {
    const at = path.join(folder, entry.name);
    return [entry.name, entry.isDirectory() ? new Directory(folderContents(at, { File, Directory })) : new File(fs.readFileSync(at))];
  }));
}

// rb_wasm_jspi's imports, as the worker gives them, for Fibers: a switch suspends the stack until something switches
// back, and resumes or starts the one it switches to.
function jspiImports(exported) {
  const suspended = new Map();
  const toSwitch = (from, to, start) => {
    const back = new Promise((resolve) => suspended.set(from, resolve));
    queueMicrotask(() => {
      if (start) return exported.fiberStart(to);

      const resume = suspended.get(to);
      suspended.delete(to);
      resume();
    });
    return back;
  };
  return { switch: new WebAssembly.Suspending(toSwitch), await: new WebAssembly.Suspending(async () => 1) };
}

// RbWasmJSPI.run, as the worker's, in a Fiber, or on the main Fiber, for the suite run directly, as Fibers only switch,
// with JSPI, in Ruby that JavaScript called through WebAssembly.promising.
const JSPI_RUBY = 'module RbWasmJSPI; class << self; attr_writer :entry, :fiber; def run = (@result = @fiber ? Fiber.new { @entry.call }.resume : @entry.call); def take = @result; end; end';

// The suite's lines from a new Ruby in the module, so one run's constants and files aren't the next's.
async function inWasm(module, code, fiber) {
  const { RubyVM, WASI, OpenFile, File, PreopenDirectory, Directory } = rubyWasm();
  const root = new PreopenDirectory('/', rootFolder ? folderContents(rootFolder, { File, Directory }) : new Map());
  const jspi = WebAssembly.Module.imports(module).some((entry) => entry.module === 'rb_wasm_jspi');
  const wasi = new WASI([], [], [...[0, 1, 2].map(() => new OpenFile(new File([]))), root], { debug: false });
  const exported = {};
  const addToImports = (imports) => { if (jspi) imports.rb_wasm_jspi = jspiImports(exported); };
  const { vm, instance } = await RubyVM.instantiateModule({ module, wasip1: wasi, args: ['ruby.wasm', '--disable-gems', '-EUTF-8', '-e_=0'], addToImports });
  if (jspi) {
    exported.fiberStart = WebAssembly.promising(instance.exports.rb_wasm_jspi_fiber_start);
    vm.eval(JSPI_RUBY);
  }
  // As the worker starts Ruby, so files packed as bytecode only are loaded from it.
  vm.eval("require 'rbconfig'\nrequire '/engine/bytecode' if File.exist?('/engine/bytecode.rb')");
  const script = `IN_FIBER = ${fiber}\n${code}`;
  let lines;
  if (jspi) {
    root.dir.contents.set('jumps_suite.rb', new File(new TextEncoder().encode(script)));
    vm.eval(`RbWasmJSPI.fiber = ${fiber}`);
    vm.eval("RbWasmJSPI.entry = -> { eval(File.read('/jumps_suite.rb'), TOPLEVEL_BINDING, 'jumps_suite.rb') }");
    await WebAssembly.promising(instance.exports.rb_wasm_jspi_eval)();
    lines = vm.eval('RbWasmJSPI.take');
  } else if (fiber) lines = await vm.evalAsync(script);
  else lines = vm.eval(script);
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
