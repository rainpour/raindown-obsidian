'use strict';

// Runs main.js's own engine and worker, with Raindown in ruby.wasm, on a copy of test/vault, as Obsidian would, and
// checks each note's written back, and rendered for reading view, as native Raindown did, in build/loaded.json, and
// that an endpoint runs, through requestUrl, which is Node's fetch here. bin/build runs it once main.js is
// built, so a file missing from the module, or a ruby.wasm update breaking the worker, fails the build, not a release.
//   node scripts/smoke.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
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

// Obsidian's requestUrl, as Node's fetch.
async function requestUrl({ url, method, headers, body }) {
  const response = await fetch(url, { method, headers, body });
  return { status: response.status, text: await response.text(), headers: Object.fromEntries(response.headers) };
}

// Whether each note's answer, written back or rendered, is native Raindown's, or else why not.
async function checkNotes(engine, folder, answers, type) {
  const failures = [];
  for (const [note, expected] of Object.entries(answers)) {
    const markdown = fs.readFileSync(path.join(folder, note), 'utf8');
    const answer = await engine[type]({ path: note, markdown, bare: false }, { timeout: 60000 }).catch((error) => ({ error }));
    if (answer.error) failures.push(`${note}: ${answer.error.message}`);
    else if (answer.output !== expected) failures.push(`${note}'s ${type} was:\n${answer.output}\nnot native Raindown's:\n${expected}`);
  }
  return failures;
}

// An endpoint, run as its command runs it, to a server of the smoke test's own.
async function checkEndpoint(engine) {
  const server = http.createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":1}'));
  await new Promise((listening) => { server.listen(0, '127.0.0.1', listening); });
  try {
    const markdown = `<!-- endpoint: -->\n\`\`\`sh\ncurl http://127.0.0.1:${server.address().port}/id\n\`\`\`\n<!-- :endpoint -->\n`;
    const { output } = await engine.rewrite({ path: 'endpoint.md', markdown, bare: false, execute: true }, { timeout: 60000 });
    return output.includes('```json\n{\n  "id": 1\n}\n```') ? [] : [`The endpoint was written back as:\n${output}`];
  } catch (error) {
    return [`The endpoint failed: ${error.message}`];
  } finally {
    server.close();
  }
}

// The worker's steps in starting, as how long each took, from the milliseconds since it began that it gives.
function steps({ vaultRead, started, ...timings }) {
  let before = 0;
  const each = Object.entries(timings).map(([step, at]) => {
    const took = at - before;
    before = at;
    return `${step} ${took}`;
  });
  return [`vaultRead ${vaultRead}`, ...each, `worker script and messages ${started - vaultRead - before}`].join(', ');
}

async function smoke() {
  const load = mainModules();
  const { RaindownEngine } = load('./engine');
  const { answers, renders } = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'loaded.json'), 'utf8'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-smoke-'));
  fs.cpSync(path.join(ROOT, 'test', 'vault'), folder, { recursive: true });
  const engine = new RaindownEngine(vaultApp(folder), { runtime: () => load('./runtime'), Worker: InProcessWorker, requestUrl });
  engine.profile = true;
  const started = performance.now();
  let failures;
  try {
    const firstNote = Object.keys(answers)[0];
    const first = performance.now();
    await engine.rewrite({ path: firstNote, markdown: fs.readFileSync(path.join(folder, firstNote), 'utf8'), bare: false }, { timeout: 60000 });
    const firstWrite = Math.round(performance.now() - first);
    console.log(`Started in ${engine.timings.started} ms, and wrote back ${firstNote} in ${firstWrite} ms: ${steps(engine.timings)}`);
    failures = [
      ...await checkNotes(engine, folder, answers, 'rewrite'), ...await checkNotes(engine, folder, renders, 'render'),
      ...await checkEndpoint(engine)
    ];
  } finally {
    engine.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
  if (failures.length) throw new Error(failures.join('\n\n'));

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`Smoke test: ${Object.keys(answers).length} notes written back and rendered as native Raindown did them, and an endpoint run, in ${seconds} s`);
}

smoke().catch((error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
