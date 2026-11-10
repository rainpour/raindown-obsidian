'use strict';

// Runs main.js's own engine and worker, with Raindown in ruby.wasm, on a copy of test/vault, as Obsidian would, and
// checks each note's written back as native Raindown wrote it, in build/loaded.json. bin/build runs it once main.js is
// built, so a file missing from the module, or a ruby.wasm update breaking the worker, fails the build, not a release.
//   node scripts/smoke.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveObjectURL } = require('node:buffer');

const ROOT = path.join(__dirname, '..');
const EXPORT = "module.exports = load('./plugin');";

// main.js's loader for its modules, without loading the plugin, which needs Obsidian.
function mainModules() {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
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
function vaultApp(folder) {
  const full = (file) => path.join(folder, file);
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
  return {
    vault: {
      adapter,
      configDir: '.obsidian',
      getAbstractFileByPath: (file) => (fs.existsSync(full(file)) ? { path: file } : null),
      modifyBinary: (file, data) => adapter.writeBinary(file.path, data),
      createBinary: (file, data) => adapter.writeBinary(file, data)
    }
  };
}

async function smoke() {
  const load = mainModules();
  const { RaindownEngine } = load('./engine');
  const { answers } = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'loaded.json'), 'utf8'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-smoke-'));
  fs.cpSync(path.join(ROOT, 'test', 'vault'), folder, { recursive: true });
  const engine = new RaindownEngine(vaultApp(folder), { runtime: () => load('./runtime'), Worker: InProcessWorker });
  const failures = [];
  const started = performance.now();
  try {
    for (const [note, expected] of Object.entries(answers)) {
      const markdown = fs.readFileSync(path.join(folder, note), 'utf8');
      const answer = await engine.rewrite({ path: note, markdown, bare: false }, { timeout: 60000 }).catch((error) => ({ error }));
      if (answer.error) failures.push(`${note}: ${answer.error.message}`);
      else if (answer.output !== expected) failures.push(`${note} was written back as:\n${answer.output}\nnot as native Raindown wrote it:\n${expected}`);
    }
  } finally {
    engine.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
  if (failures.length) throw new Error(failures.join('\n\n'));

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`Smoke test: ${Object.keys(answers).length} notes written back as native Raindown wrote them, in ${seconds} s`);
}

smoke().catch((error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
