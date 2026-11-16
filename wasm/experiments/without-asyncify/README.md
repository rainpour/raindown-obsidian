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

Switching Fibers and calling blocks from C cost little, as [bench/switches.rb](bench/switches.rb) times. A switch suspends JSPI's stack and resumes another in a microtask, yet a resume and its yield take 1.3 µs, where Asyncify's take 4.4, so `Enumerator#next` is 2.5 to 3.5 times as fast. A block called from C, like `(0...1000).each`'s, runs `vm_exec`'s setjmp and V8's `try` each time, and takes 26 ns longer than a block Ruby yields to, like `1000.times`'s, where it takes 16 ns longer with Asyncify and 4 natively. In a profile of the first, `rb_vm_exec` itself takes 7.5% of the time, about the most that taking out its setjmp could save, and `invoke_block_from_c_bh` 15%.

## What it took

- A wasi-sdk with LLVM 19 or later, like wasi-sdk 34, whose setjmp keeps its state in the `jmp_buf`. LLVM 18's, in rbwasm's wasi-sdk 24, allocates a table for each call of a function that calls setjmp, so each block called from C, which runs `vm_exec`, mallocs and frees one, and iterating is a third slower.
- Binaryen's `--flatten`, `--coalesce-locals` and `--spill-pointers`, after linking, from a Binaryen that has them, like version_131, as rbwasm's 108 hasn't got `--spill-pointers`. Without `--flatten`, a value on WebAssembly's stack across a call, rather than in a local, isn't spilled, like the Fiber `rb_fiber_new` passes to `fiber_initialize` while `rb_proc_new` allocates, so it's collected, which [bench/enumerators.rb](bench/enumerators.rb) catches under `GC.stress`. Without `--coalesce-locals`, each of a function's locals has its own place on the stack, so `vm_exec_core`'s frame is 25 KB rather than 80 bytes, and 300 levels of recursion through C overflow a Fiber's 2 MB.
- wasi-vfs can't compile exception handling, so neither module is packed with Ruby's files, which `main.js` has, and the worker gives Ruby in its folders.
- Fibers only switch in Ruby that JavaScript called through `WebAssembly.promising`, so the worker answers through `rb_wasm_jspi_eval`, in a Fiber, as `evalAsync` does, so too deep a stack raises `SystemStackError` before JSPI's stack, of 984 KB, overflows. [bench/fibers.rb](bench/fibers.rb) checks they switch as native Ruby's do.

## Collecting only between requests

Spilling's cost is in Ruby's C, not its VM: without `--spill-pointers`, [bench/idle.rb](bench/idle.rb), collecting between rounds, loops over arrays and hashes take 15 to 30% less time, allocating 300,000 objects 99 ms rather than 120, and garbage collection less than half as long, while a `while` loop and `fib` take the same. [ruby-4.0-jspi-idle-gc.patch](ruby-4.0-jspi-idle-gc.patch), with [idle-gc-plugin.diff](idle-gc-plugin.diff)'s build and worker, builds the module without it, and collects only in `rb_wasm_jspi_gc`, which the worker calls after each answer, with no Ruby on the stack, and not while a Fiber's suspended. It writes back the smoke test's notes as native Raindown does, and passes the jumps suite. With [notes.js](notes.js), in Node 26:

| What                              | Spilled     | Collecting between requests |
| --------------------------------- | ----------- | --------------------------- |
| A note of ten sales nodes         | 840–901 ms  | 619–686 ms, then 70 ms collecting |
| Raindown started                  | 470–643 ms  | 395–409 ms                  |
| The module, and `main.js`         | 7.6, 6.40 MB | 4.8, 5.99 MB               |
| The process's peak memory         | 261 MB      | 419 MB                      |

But WebAssembly's memory never shrinks, so it stays as big as the heaviest request made it, 534 MB after the sales nodes, from 313, a Fiber left suspended, like an `Enumerator` part way through `next`, stops collection for good, and the jumps suite's `GC.stress` cases no longer collect at all.

## Collecting only at interrupt checks

[ruby-4.0-jspi-safepoint-gc.patch](ruby-4.0-jspi-safepoint-gc.patch) keeps memory bounded, collecting at the next interrupt check after Ruby wants to, rather than between requests, and [binaryen-131-safepoint.patch](binaryen-131-safepoint.patch)'s `--spill-pointers` spills only at calls that can reach that and return, as a frame a jump unwinds through never resumes. Under `GC.stress`, [bench/check.rb](bench/check.rb), [bench/enumerators.rb](bench/enumerators.rb) and [bench/fibers.rb](bench/fibers.rb) give native Ruby's answers, it collects as often as the spilled module, and its heap's as big. But 5,915 of 7,909 functions can still reach it, through paths Raindown never takes but C can: allocating runs garbage collection's event hooks, which can call a trace proc, raising runs Ruby, and an indirect call reaches every function of its type, like `vfprintf`'s write, which is a cfunc's. So it's 1.49 MB with gzip, rather than 1.55 spilled and 1.21 without, and in [bench/normal.rb](bench/normal.rb), in ms, collecting as it goes, but without spilling, which collects between rounds:

| Workload                 | Spilled | At interrupt checks | Without spilling |
| ------------------------ | ------- | ------------------- | ---------------- |
| The sales node           | 92      | 61–64               | 52–55            |
| 300k objects allocated   | 164–177 | 165–166             | 96               |
| `Array#each` 200k        | 24–25   | 22–23               | 18               |
| `Hash[str]` 200k         | 43–48   | 44                  | 36–37            |
| `Hash build str` 100×1k  | 42–44   | 41                  | 34               |
| All of it                | 10.6–11.3 s | 10.3–10.5 s     | 8.6–8.7 s        |

The sales node gains most of the way, as marking and sweeping no longer spill, but loops and allocating hardly at all, as nearly everything they call can still raise or call Ruby. Only taking out those paths, each with a guarantee they're never taken, would spill less.

## Between requests or at interrupt checks, in the plugin

Each built into `main.js`, with its smoke test and jumps suite passing, and timed with [notes.js](notes.js), in Node 26, against the spilled module, in ms, on raindown-benchmarks' vault of a year of 2,000 orders, with `work_rb.md` its note of ten sales nodes, and that note again on 20,000:

| What                                    | Spilled   | Between requests | At interrupt checks |
| --------------------------------------- | --------- | ---------------- | ------------------- |
| `main.js`                               | 6.40 MB   | 5.99 MB          | 6.31 MB             |
| Raindown started                        | 472–547   | 411–423          | 421–469             |
| Ten sales nodes, 2,000 orders           | 102–119   | 78–80            | 87–95               |
| The benchmarks' vault, all of it        | 2838–2931 | 2129–2147        | 2299–2431           |
| The test vault, all of it               | 3925–4088 | 3383–3482        | 3590–3839           |
| Ten sales nodes, 20,000 orders          | 843–933   | 697–728, then 72 collecting | 821–1048 |
| The process's peak memory, 20,000 orders | 288–335 MB | 432–480 MB    | 291–357 MB          |

Collecting between requests is 15 to 25% faster throughout, but its memory grows with the heaviest request, about 200 MB more for 20,000 orders, and stays. Collecting at interrupt checks keeps memory as the spilled module's, but is 5 to 15% faster on notes of a size a note's data is, and no faster on the heavier one.

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

# Where the time goes, in a module whose functions have names: linked again without post-linking, then post-linked
# with -g each time, as one wasm-opt without it drops the stack pointer's name, which --spill-pointers needs
rm OUT/ruby && make -C OUT ruby POSTLINK=: && wasm-opt -g --strip-dwarf OUT/ruby -o ruby.wasm
wasm-opt -g --flatten --coalesce-locals --spill-pointers -O3 --enable-exception-handling ruby.wasm -o ruby.wasm
node --cpu-prof --cpu-prof-dir=prof wasm/experiments/without-asyncify/run.js ruby.wasm bench hash.rb
node wasm/experiments/without-asyncify/profile.js prof/*.cpuprofile
```

[notes.js](notes.js) times each note in a vault with a `main.js`, as JSON, with how long Raindown took to start, and which module it started.
