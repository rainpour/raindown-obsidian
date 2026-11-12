# Development

## Architecture

Raindown runs inside the plugin, in [ruby.wasm](https://github.com/ruby/ruby.wasm), Ruby compiled to WebAssembly, in a Web Worker, so typing never waits for it. `src/engine.js` starts the worker, `src/worker.js`, which starts Ruby once, loads Raindown, and then answers each write-back on the Ruby it kept running, with `src/engine.rb`. Starting takes about a second, and each write-back after that a few milliseconds. The plugin applies what Raindown wrote back through Obsidian, and only if the note hasn't changed since, so nothing you type is lost. Notes without directives, like `<!-- toc: -->`, or `raindown: true` in their front matter, don't start Raindown.

Ruby can't wait for Obsidian to read a file, so the worker has a copy of the vault's notes, data files and `.raindown` folders in Ruby's in-memory folder, at `/vault`, sent as it starts and as they change. The files Raindown writes, like a table's CSV, come back with each answer, and the plugin writes them through Obsidian. Obsidian doesn't say when a hidden file changes, so each write-back checks the `.raindown` folders first, and starts Raindown again when they've changed, so their nodes load again. Raindown's given the front matter Obsidian's already read, and told which files changed at each write-back, rather than reading every note, or checking their modified times, for a `list:`, which takes seconds in a vault of thousands of notes in WebAssembly.

WebAssembly has no processes or sockets, so Ruby waits on the worker, through ruby.wasm's `evalAsync`, for what needs them, which `src/worker.rb` asks for: an endpoint's request, which the worker sends to Obsidian's main thread, for `requestUrl`, and a project's JavaScript components, which run in the worker, imported from their text, rather than in Node.js. Raindown's services, `raindown` in a node's context, are answered by the worker too, for Ruby nodes, through `Raindown::Services.host`, and for JavaScript ones, through Raindown's `services.js`, which `bin/build` puts before the worker's code: files from its copy of the vault, which go back with the answer like a table's CSV, `fetch` through `requestUrl`, a cache in IndexedDB, by vault, and no `git`. So the worker answers one request at a time. Commonmarker is native too, so reading view's `<{ }>` sections are rendered by Raindown as Markdown, with `commonmark: false`, then by Obsidian's `MarkdownRenderer`.

## Building

Obsidian loads one file, `main.js`, which `bin/build` builds from `src/`, with Raindown packed into ruby.wasm's module, compressed with xz, which makes it about a third smaller than gzip does, in Z85, a base 85 a fifteenth smaller than base64, and decompressed in the worker by [xz-decompress](https://github.com/httptoolkit/xz-decompress), downloaded into `build/` with ruby.wasm. Building needs `xz`. Edit `src/`, not `main.js`, which git ignores, as CI builds it for a release. It needs a checkout of Raindown, at `../raindown` or `RAINDOWN_DIR`, with its gems installed, and `wasm/Gemfile`'s gems, `rbwasm` and the `js` gem, in the same Ruby. With [wasmtime](https://wasmtime.dev), as `WASMTIME`, it also compiles Raindown to bytecode, which halves how long it takes to load. Then only the bytecode's packed, with each source file left empty, but for `rbconfig.rb`, which loads before the bytecode can, as Ruby needs to find a file to require it, which makes `main.js` smaller. It downloads ruby.wasm into `build/` the first time.

```sh
BUNDLE_GEMFILE=wasm/Gemfile bundle install
WASMTIME=~/.wasmtime/bin/wasmtime bin/build
```

Raindown's packed into a ruby.wasm module of the plugin's own, which `scripts/ruby_wasm.rb` builds the first time, as ruby.wasm's npm package builds its own, but with only the extensions Raindown and a vault's nodes use. It leaves out OpenSSL, as Obsidian makes the plugin's HTTPS requests, and WebAssembly has no sockets, and tools' extensions, like ripper. Building it compiles Ruby for WebAssembly, which takes a while, so it's kept in `build/module`, and CI caches it. It's built again when the script or `wasm/Gemfile.lock` changes. A vault's node that requires an extension that's left out fails to load it.

`scripts/trace.rb` writes back `test/vault`, with a note for each of Raindown's directives, and lists the Ruby files that loaded, so only those are packed. A directive that loads a file the vault doesn't would fail in the plugin, so give the vault a note using it.

Starting Raindown is timed step by step: reading the vault, decoding and decompressing the module, compiling it, starting Ruby, copying the vault in and loading Raindown. Obsidian's console shows it as `Raindown started`, in milliseconds from when the worker began each step, and the smoke test prints how long each took, with the first write-back's.

Once `main.js` is built, `scripts/smoke.js` runs its worker, with Raindown in WebAssembly, in Node, on a copy of `test/vault`, and fails the build unless each note's written back as native Raindown wrote it in `scripts/trace.rb`. So a file missing from the module, or a ruby.wasm update that breaks the worker, is caught before a release. Without Node, `bin/build` skips it, except in CI, which always runs it. Run it again on its own with `node scripts/smoke.js`.

## Testing

The tests run outside Obsidian, with a stub of Obsidian's API, and a stand-in for Raindown:

```sh
npm test
```

To link it into a vault while you work on it, `ln -s "$PWD" VAULT/.obsidian/plugins/raindown`, then build it, and reload Obsidian. Building again is needed after changing Raindown too.

### Releasing

Obsidian installs a plugin from its GitHub repo's releases, so the plugin is released from a repo of its own, with this folder as its root. `bin/bump` runs `npm version minor`, or `patch` with `--patch` or `-p`, or `major` with `--major`, which sets the version in `package.json` and `manifest.json`, adds it to `versions.json` with the oldest Obsidian it runs on, and tags it without a `v`, like `0.2.0`, as Obsidian needs, then pushes it. CI then runs the tests, builds `main.js` with Raindown at `RAINDOWN_VERSION`, a tag like `v0.19.0`, or a commit, runs the smoke test, and attaches `main.js`, `manifest.json` and `styles.css` to a release, with an attestation that CI built them. It builds and smoke tests each push to `main` too. To build with a new Raindown, release it, then set `RAINDOWN_VERSION` to its tag:

```sh
bin/bump # minor
bin/bump --patch
bin/bump -p
bin/bump --major
```
