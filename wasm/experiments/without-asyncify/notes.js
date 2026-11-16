'use strict';

// Each note's median write-back, in milliseconds, by a main.js's engine and worker, run in Node as the smoke test runs
// it, over a vault, as JSON, with how long Raindown took to start. Built with a worker that answers with vm.eval, as
// Fibers trap without Asyncify, so a vault's JavaScript components and Raindown's services, which wait with evalAsync,
// can't be used, and a note that needs them gives why it failed instead.
//   node notes.js main.js VAULT [NOTE.md ...]
const fs = require('node:fs');
const path = require('node:path');
const { resolveObjectURL } = require('node:buffer');

const [mainJs, folder, ...only] = process.argv.slice(2);
const EXPORT = "module.exports = load('./plugin');";
const RUNS = 11;
const WARMUP = 3;

// main.js's loader for its modules, without loading the plugin, which needs Obsidian.
function mainModules() {
  const source = fs.readFileSync(mainJs, 'utf8');
  if (!source.includes(EXPORT)) throw new Error(`main.js no longer ends with ${EXPORT}`);

  return new Function('require', source.replace(EXPORT, 'return load;'))(require);
}

// A Web Worker, which Node doesn't have, run in this process, with its code's self as a scope of its own over the
// global one, where ruby.wasm's bundle puts itself.
class InProcessWorker {
  constructor(url) {
    this.scope = Object.create(globalThis);
    this.scope.postMessage = (data) => setImmediate(() => this.onmessage({ data }));
    this.started = resolveObjectURL(url).text().then((code) => new Function('self', code)(this.scope));
  }

  postMessage(data) {
    this.started.then(() => this.scope.onmessage({ data: structuredClone(data) }), (error) => this.onerror(error));
  }

  terminate() {}
}

// Just enough of Obsidian's vault, over a folder, for the engine.
function vaultApp(root) {
  const full = (file) => path.join(root, file);
  const adapter = {
    async list(at) {
      const entries = fs.readdirSync(full(at), { withFileTypes: true });
      const paths = (kind) => entries.filter((entry) => entry[kind]()).map((entry) => (at ? `${at}/${entry.name}` : entry.name));
      return { files: paths('isFile'), folders: paths('isDirectory') };
    },
    async stat(file) {
      const stat = fs.statSync(full(file), { throwIfNoEntry: false });
      return stat && { size: stat.size, mtime: stat.mtimeMs };
    },
    async readBinary(file) {
      const bytes = fs.readFileSync(full(file));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    exists: async (file) => fs.existsSync(full(file)),
    mkdir: async (at) => fs.mkdirSync(full(at), { recursive: true }),
    writeBinary: async (file, data) => fs.writeFileSync(full(file), Buffer.from(data))
  };
  const file = (at) => fs.existsSync(full(at)) && { path: at };
  return {
    vault: {
      adapter,
      configDir: '.obsidian',
      getAbstractFileByPath: (at) => file(at) || null,
      modifyBinary: (at, data) => adapter.writeBinary(at.path, data),
      createBinary: (at, data) => adapter.writeBinary(at, data)
    }
  };
}

// New props each run, so every node is made again, not kept from the last.
const withNewProps = (markdown) => markdown.replace(/\bn(: |=)\d+/g, (_, separator) => `n${separator}${Math.floor(Math.random() * 100000)}`);

// Each note's median write-back in milliseconds, or why it couldn't be written back, as Fibers trap without Asyncify.
async function median(engine, note) {
  const markdown = fs.readFileSync(path.join(folder, note), 'utf8');
  const times = [];
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    const answer = await engine.rewrite({ path: note, markdown: withNewProps(markdown), bare: false }, { timeout: 120000 });
    times.push(performance.now() - started);
    if (answer.error) return answer.error.slice(0, 60);
    if (/WARNING|Couldn/.test(answer.output) || answer.warnings?.length) return `warned: ${(answer.warnings || []).join(" ").slice(0, 120)} ${answer.output.slice(0, 120)}`;
  }
  const warm = times.slice(WARMUP).sort((a, b) => a - b);
  return Math.round(warm[warm.length >> 1] * 100) / 100;
}

async function bench() {
  const load = mainModules();
  const { RaindownEngine } = load('./engine');
  fs.mkdirSync(path.join(folder, '.obsidian'), { recursive: true });
  const requestUrl = async () => { throw new Error('Nothing is fetched'); };
  const engine = new RaindownEngine(vaultApp(folder), { runtime: () => load('./runtime'), Worker: InProcessWorker, requestUrl });
  const notes = only.length ? only : fs.readdirSync(folder).filter((name) => name.endsWith('.md'));
  const times = {};
  const log = console.debug;
  console.debug = () => {};
  try {
    for (const note of notes) times[note] = await median(engine, note).catch((error) => error.message.slice(0, 60));
  } finally {
    engine.stop();
    console.debug = log;
  }
  console.log(JSON.stringify({ started: engine.timings, times }));
}

bench().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
