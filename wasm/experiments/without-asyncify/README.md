# Ruby without Asyncify

An experiment, not part of the plugin's build: Ruby 4.0 in WebAssembly with setjmp from WebAssembly exception handling, and pointers spilled to the stack in memory for garbage collection, rather than Asyncify, which instruments most of Ruby's C so it can unwind and rewind the stack. The plugin's patches are in `wasm/patches`, which `scripts/ruby_wasm.rb` applies every one of, so this one's here.

## What it changes

[ruby-4.0-without-asyncify.patch](ruby-4.0-without-asyncify.patch) says how, in 75 lines of C, applied with `wasm/patches/ruby-4.0-wasm-shapes.patch` but not the jumps patch, whose try/catch is Asyncify's. It needs:

- A Binaryen with `--spill-pointers`, like version_131, as rbwasm's 108 hasn't got it. Without it, garbage collection frees objects only a WebAssembly local points to, and Ruby crashes.
- A wasi-sdk with LLVM 19 or later, like wasi-sdk 34, whose setjmp keeps its state in the `jmp_buf`. LLVM 18's, in rbwasm's wasi-sdk 24, allocates a table for each call of a function that calls setjmp, so each block called from C, which runs `vm_exec`, mallocs and frees one.
- Fibers trap, as nothing can switch stacks. So the worker can't use `evalAsync`, and a vault's JavaScript components and Raindown's services, which wait with it, don't work. JSPI could switch them, but Safari hasn't shipped it.

## How it compares

[bench/bench.rb](bench/bench.rb) and [bench/hash.rb](bench/hash.rb), in milliseconds, the median of rounds after warming up, in Node, on Ruby built by [build.sh](build.sh) without gems: today's plugin's Ruby, with Asyncify and the jumps patch, from wasi-sdk 24 and Binaryen 108, against Ruby without Asyncify, from wasi-sdk 34 and Binaryen 131.

| Workload                | Today | Without Asyncify | Faster |
| ----------------------- | ----- | ---------------- | ------ |
| The sales node          | 151.5 | 94.1             | 1.61×  |
| `Array#each` 200k       | 36.8  | 22.3             | 1.65×  |
| `Hash#each` 200k        | 44.4  | 28.4             | 1.56×  |
| `Hash[str]` 200k        | 79.9  | 44.1             | 1.81×  |
| `Hash[sym]` 200k        | 60.8  | 31.9             | 1.91×  |
| `while` over an Array   | 21.4  | 11.0             | 1.94×  |
| `ensure` ×200k          | 29.5  | 17.0             | 1.74×  |
| 300k objects allocated  | 283.6 | 181.0            | 1.57×  |
| `gsub` and `scan`       | 128.2 | 76.4             | 1.68×  |
| `raise` and `rescue` ×20k | 55.0 | 55.3            | 0.99×  |
| `catch` and `throw` ×20k | 16.0  | 39.2            | 0.41×  |

Without Asyncify, Ruby's module is also an eighth smaller. Today's Ruby from wasi-sdk 34 is slower than from 24, so it's leaving out Asyncify that's faster, not the newer compiler.

In the plugin, with its extensions and the js gem, from [ruby_wasm.rb](ruby_wasm.rb) and [plugin.patch](plugin.patch), [notes.js](notes.js) times the benchmarks' Ruby notes and `test/vault`'s, in milliseconds, the median of two runs. Each note's written back the same, byte for byte, as today's plugin writes it.

| Note                         | Today | Without Asyncify | Faster |
| ---------------------------- | ----- | ---------------- | ------ |
| `work_rb`, ten sales nodes   | 1320  | 844              | 1.56×  |
| `write_rb`, ten lines        | 7.9   | 4.4              | 1.78×  |
| `bare`                       | 6.1   | 4.4              | 1.38×  |
| `chart`                      | 3.5   | 2.5              | 1.42×  |
| `jumps`, thousands of jumps  | 148   | 266              | 0.56×  |
| Starting                     | 790   | 681              | 1.16×  |

Its `main.js` is 5.2 MB, rather than 5.5 MB.

A `longjmp` is a WebAssembly exception, which takes V8 about 0.4 µs, and as much again for each frame between that calls setjmp, which catches it and throws it again, as [bench/sjlj.c](bench/sjlj.c) times. A `throw` jumps twice, to its block's `vm_exec` and then to its `catch`, so it takes about 2 µs, where the jumps patch, unwinding a few frames with Asyncify, takes less. Only jumping fewer times would make it faster.

## Running it

`bench/bench.rb` reads `bench/sales.csv`, the benchmarks' year of orders, which [raindown-benchmarks](https://github.com/rainpour/raindown-benchmarks)' `Project.copy` writes to its project's `data/sales.csv`.

```sh
# Ruby without gems, as today's plugin builds it and without Asyncify, into OUT/ruby
wasm/experiments/without-asyncify/build.sh build/today
WASI_SDK=.../wasi-sdk-34.0-x86_64-macos BINARYEN=.../binaryen-version_131 wasm/experiments/without-asyncify/build.sh build/eh eh

# A benchmark, a check against native Ruby's answers, and the same under GC.stress
node wasm/experiments/without-asyncify/run.js build/eh/ruby wasm/experiments/without-asyncify/bench hash.rb
node wasm/experiments/without-asyncify/run.js build/eh/ruby wasm/experiments/without-asyncify/bench check.rb
ruby --disable-gems wasm/experiments/without-asyncify/bench/check.rb

# Where the time goes, in a module whose functions have names
node --cpu-prof --cpu-prof-dir=prof wasm/experiments/without-asyncify/run.js ruby.wasm bench hash.rb
node wasm/experiments/without-asyncify/profile.js prof/*.cpuprofile
```

The plugin's module, with its extensions and the js gem, is built by [ruby_wasm.rb](ruby_wasm.rb), as `scripts/ruby_wasm.rb` builds it, in an rbwasm root of its own. rbwasm then fails to pack it with wasi-vfs, which can't compile exception handling, but leaves it unpacked, as `rubies/ruby-4.0-wasm32-unknown-wasip1-full-*/usr/local/bin/ruby` in that root. [plugin.patch](plugin.patch), applied to a copy of raindown-obsidian, has the worker answer with `vm.eval`, and `bin/build` give it Ruby's files in `main.js`, rather than packing them:

```sh
git apply wasm/experiments/without-asyncify/plugin.patch
NO_VFS=1 RUBY_WASM=.../usr/local/bin/ruby BUNDLE_GEMFILE=wasm/Gemfile bundle exec bin/build
node wasm/experiments/without-asyncify/notes.js main.js VAULT
```

`bin/build`'s smoke test then fails, as its vault has JavaScript components and an endpoint, which wait with `evalAsync`, after `main.js` is built. [notes.js](notes.js) times each note in a vault without them, whose nodes read files directly, like `File.read('/vault/data/sales.csv')`, rather than through Raindown's services.
