# Development

## Architecture

Raindown runs inside the plugin, in [ruby.wasm](https://github.com/ruby/ruby.wasm), Ruby compiled to WebAssembly, in a Web Worker, so typing never waits for it. `src/engine.js` starts the worker, `src/worker.js`, which starts Ruby once, loads Raindown, and then answers each write-back on the Ruby it kept running, with `src/engine.rb`. Starting takes about a second, and each write-back after that a few milliseconds. The plugin applies what Raindown wrote back through Obsidian, and only if the note hasn't changed since, so nothing you type is lost. Notes without directives, like `<!-- toc: -->`, or `raindown: true` in their front matter, don't start Raindown.

Ruby can't wait for Obsidian to read a file, so the worker has a copy of the vault's notes, data files and `.raindown` folders in Ruby's in-memory folder, at `/vault`, sent as it starts and as they change. The files Raindown writes, like a table's CSV, come back with each answer, and the plugin writes them through Obsidian. Obsidian doesn't say when a hidden file changes, so each write-back checks the `.raindown` folders first, and starts Raindown again when they've changed, so their nodes load again. Raindown's given the front matter Obsidian's already read, and told which files changed at each write-back, rather than reading every note, or checking their modified times, for a `list:`, which takes seconds in a vault of thousands of notes in WebAssembly.

Endpoints and JavaScript nodes need processes and sockets, which WebAssembly doesn't have, and `<{ }>` in reading view needs Commonmarker, which is native, so they don't run in the plugin yet.

## Building

Obsidian loads one file, `main.js`, which `bin/build` builds from `src/`, with Raindown packed into ruby.wasm's module, gzipped in base64. Edit `src/`, not `main.js`. It needs a checkout of Raindown, at `../raindown` or `RAINDOWN_DIR`, with its gems installed, and `rbwasm`, from the `ruby_wasm` gem, in the same Ruby. With [wasmtime](https://wasmtime.dev), as `WASMTIME`, it also compiles Raindown to bytecode, which halves how long it takes to load. It downloads ruby.wasm into `build/` the first time.

```sh
gem install ruby_wasm
WASMTIME=~/.wasmtime/bin/wasmtime bin/build
```

`scripts/trace.rb` writes back `test/vault`, with a note for each of Raindown's directives, and lists the Ruby files that loaded, so only those are packed. A directive that loads a file the vault doesn't would fail in the plugin, so give the vault a note using it.

Once `main.js` is built, `scripts/smoke.js` runs its worker, with Raindown in WebAssembly, in Node, on a copy of `test/vault`, and fails the build unless each note's written back as native Raindown wrote it in `scripts/trace.rb`. So a file missing from the module, or a ruby.wasm update that breaks the worker, is caught before a release. Run it again on its own with `node scripts/smoke.js`.

## Testing

The tests run outside Obsidian, with a stub of Obsidian's API, and a stand-in for Raindown:

```sh
npm test
```

To link it into a vault while you work on it, `ln -s "$PWD" VAULT/.obsidian/plugins/raindown`, then build it, and reload Obsidian. Building again is needed after changing Raindown too.

### Releasing

Obsidian installs a plugin from its GitHub repo's releases, so the plugin is released from a repo of its own, with this folder as its root. `bin/bump` builds `main.js` and commits it, then runs `npm version minor`, or `patch` with `--patch` or `-p`, or `major` with `--major`, which sets the version in `package.json` and `manifest.json`, adds it to `versions.json` with the oldest Obsidian it runs on, and tags it without a `v`, like `0.2.0`, as Obsidian needs, then pushes it, which runs the tests and attaches `main.js`, `manifest.json` and `styles.css` to a release:

```sh
bin/bump # minor
bin/bump --patch
bin/bump -p
bin/bump --major
```
