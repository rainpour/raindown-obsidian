# Ruby without Asyncify

How the plugin's module for JSPI was worked out and timed: Ruby 4.0 in WebAssembly with setjmp from WebAssembly exception handling, pointers spilled to the stack in memory for garbage collection, and Fibers as JSPI's stacks, rather than Asyncify, which instruments most of Ruby's C so it can unwind and rewind the stack. Its patch is [wasm/patches/jspi](../../patches/jspi), which `scripts/ruby_wasm.rb --jspi` builds the module with, and `bin/build` puts it in `main.js` beside Asyncify's, which the worker uses where the engine hasn't got JSPI, like Safari.

## How it compares

[bench/bench.rb](bench/bench.rb) and [bench/hash.rb](bench/hash.rb), in milliseconds, the median of rounds after warming up, in Node, on Ruby built by [build.sh](build.sh) without gems: today's plugin's Ruby, with Asyncify and the jumps patch, from wasi-sdk 24 and Binaryen 108, against Ruby without Asyncify, from wasi-sdk 34 and Binaryen 131, run with [run-jspi.js](run-jspi.js).

| Workload                  | Asyncify | Without | Faster |
| ------------------------- | -------- | ------- | ------ |
| The sales node            | 141.1    | 81.8    | 1.73×  |
| `Array#each` 200k         | 31.7     | 22.0    | 1.44×  |
| `Hash#each` 200k          | 41.3     | 26.1    | 1.58×  |
| `Hash[str]` 200k          | 66.0     | 37.4    | 1.76×  |
| `Hash[sym]` 200k          | 51.1     | 28.5    | 1.79×  |
| `while` over an Array     | 19.3     | 9.5     | 2.02×  |
| `ensure` ×200k            | 25.6     | 14.5    | 1.76×  |
| 300k objects allocated    | 261.4    | 162.2   | 1.61×  |
| `gsub` and `scan`         | 116.2    | 70.4    | 1.65×  |
| `raise` and `rescue` ×20k | 50.1     | 51.2    | 0.98×  |
| `catch` and `throw` ×20k  | 15.0     | 35.5    | 0.42×  |

In the plugin, with its extensions and the js gem, the smoke test starts Raindown in about three quarters of the time, 750 ms rather than 1000. The module's 3.1 MB with gzip, rather than Asyncify's 2.5 MB, as its spilled locals are stored before each call, so `main.js`, with both, is about 9.9 MB.

A `longjmp` is a WebAssembly exception, which takes V8 about 0.4 µs, and as much again for each frame between that calls setjmp, which catches it and throws it again, as [bench/sjlj.c](bench/sjlj.c) times. A `throw` jumps twice, to its block's `vm_exec` and then to its `catch`, so it takes about 2 µs, where the jumps patch, unwinding a few frames with Asyncify, takes less. Only jumping fewer times would make it faster.

## What it took

- A wasi-sdk with LLVM 19 or later, like wasi-sdk 34, whose setjmp keeps its state in the `jmp_buf`. LLVM 18's, in rbwasm's wasi-sdk 24, allocates a table for each call of a function that calls setjmp, so each block called from C, which runs `vm_exec`, mallocs and frees one, and iterating is a third slower.
- Binaryen's `--flatten`, `--coalesce-locals` and `--spill-pointers`, after linking, from a Binaryen that has them, like version_131, as rbwasm's 108 hasn't got `--spill-pointers`. Without `--flatten`, a value on WebAssembly's stack across a call, rather than in a local, isn't spilled, like the Fiber `rb_fiber_new` passes to `fiber_initialize` while `rb_proc_new` allocates, so it's collected, which [bench/enumerators.rb](bench/enumerators.rb) catches under `GC.stress`. Without `--coalesce-locals`, each of a function's locals has its own place on the stack, so `vm_exec_core`'s frame is 25 KB rather than 80 bytes, and 300 levels of recursion through C overflow a Fiber's 2 MB.
- wasi-vfs can't compile exception handling, so neither module is packed with Ruby's files, which `main.js` has, and the worker gives Ruby in its folders.
- Fibers only switch in Ruby that JavaScript called through `WebAssembly.promising`, so the worker answers through `rb_wasm_jspi_eval`, in a Fiber, as `evalAsync` does, so too deep a stack raises `SystemStackError` before JSPI's stack, of 984 KB, overflows. [bench/fibers.rb](bench/fibers.rb) checks they switch as native Ruby's do.

## Running it

`bench/bench.rb` reads `bench/sales.csv`, the benchmarks' year of orders, which [raindown-benchmarks](https://github.com/rainpour/raindown-benchmarks)' `Project.copy` writes to its project's `data/sales.csv`.

```sh
# Ruby without gems, as today's plugin builds it and without Asyncify, into OUT/ruby
wasm/experiments/without-asyncify/build.sh build/asyncify
WASI_SDK=.../wasi-sdk-34.0-x86_64-macos BINARYEN=.../binaryen-version_131 wasm/experiments/without-asyncify/build.sh build/jspi eh

# A benchmark, or a check against native Ruby's answers, with each
node wasm/experiments/without-asyncify/run.js build/asyncify/ruby wasm/experiments/without-asyncify/bench hash.rb
node wasm/experiments/without-asyncify/run-jspi.js build/jspi/ruby wasm/experiments/without-asyncify/bench fibers.rb
ruby --disable-gems wasm/experiments/without-asyncify/bench/fibers.rb

# Where the time goes, in a module whose functions have names, from wasm-opt with -g
node --cpu-prof --cpu-prof-dir=prof wasm/experiments/without-asyncify/run.js ruby.wasm bench hash.rb
node wasm/experiments/without-asyncify/profile.js prof/*.cpuprofile
```

[notes.js](notes.js) times each note in a vault with a `main.js`, as JSON, with how long Raindown took to start, and which module it started.
