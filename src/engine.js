'use strict';

// Raindown, in Ruby compiled to WebAssembly, in a Web Worker, which src/worker.js runs. The worker can't read the vault,
// and Ruby can't wait for it to, so the vault's files Raindown reads, like notes, data files and .raindown folders, are
// sent to it as it starts, and each change after. The files Raindown writes, like a table's CSV, come back with each
// answer, and are written to the vault.
const MIRRORED = /\.(?:md|rd|raindown|markdown|csv|tsv|json|ya?ml|rb|rbx|js|mjs|txt)$/i;
const SKIPPED_FOLDERS = new Set(['.git', '.trash', 'node_modules']);
const LARGEST_FILE = 4 * 1024 * 1024;
const NODES_FOLDER = '.raindown';
// How long Raindown has to start and give its first answer, as Ruby starts and loads Raindown first.
const START_TIMEOUT = 60000;
// A link-local host, as a URL has it, like cloud metadata at 169.254.169.254, however it was written, which an
// endpoint can't request, as with curl in Raindown.
const LINK_LOCAL = /^(?:169\.254\.\d+\.\d+|\[(?:fe[89ab][0-9a-f]:[^\]]*|::ffff:a9fe:[0-9a-f]+)\])$/i;

class RaindownEngine {
  // runtime gives what bin/build embeds in main.js: the module, the worker's code and the load path. requestUrl sends
  // endpoints' requests, as Obsidian's does.
  constructor(app, {
    runtime = () => require('./runtime'), Worker = globalThis.Worker, requestUrl = (request) => require('obsidian').requestUrl(request)
  } = {}) {
    this.app = app;
    this.runtime = runtime;
    this.Worker = Worker;
    this.requestUrl = requestUrl;
    this.pending = new Map();
    this.nextId = 1;
  }

  // The note, { path, markdown, bare }, as Raindown writes it back, running its endpoints with execute: true, resolving
  // with { output, warnings, written }, or rejecting with Raindown's error, or when it didn't answer in time.
  rewrite(note, { timeout }) {
    return this.answer({ type: 'rewrite', ...note }, timeout);
  }

  // The note rendered as Markdown, with its <{ }> filled in, for reading view, which Obsidian renders, as { output }.
  render(note, { timeout }) {
    return this.answer({ type: 'render', ...note }, timeout);
  }

  async answer(request, timeout) {
    if (await this.nodesChanged()) this.stop();
    await this.start();
    const answer = await this.ask(request, timeout);
    await Promise.all(answer.written.map(([file, bytes]) => this.writeFile(file, bytes)));
    return answer;
  }

  // Started once, and again after it's stopped, like when a .raindown folder changed, so its nodes load again.
  start() {
    this.starting ??= (async () => {
      const began = performance.now();
      const { wasm, wasmSize, worker, loadPaths } = this.runtime();
      const [files, nodes] = [[], new Map()];
      await this.readFolder('', files, nodes);
      this.nodes = nodes;
      this.worker = new this.Worker(URL.createObjectURL(new Blob([worker], { type: 'text/javascript' })));
      this.worker.onmessage = ({ data }) => this.receive(data);
      this.worker.onerror = (event) => this.fail(new Error(`Raindown stopped: ${event.message}`));
      const frontMatters = Object.fromEntries(files.flatMap(([path]) => this.frontMatter(path)));
      const vault = this.app.vault.getName?.() ?? '';
      const vaultRead = Math.round(performance.now() - began);
      const { timings, report } = await this.ask({ type: 'start', wasm, wasmSize, loadPaths, files, frontMatters, vault, profile: this.profile }, START_TIMEOUT, files.map(([, bytes]) => bytes));
      // How long starting took, in milliseconds: reading the vault, each of the worker's steps, from when it began, and
      // in all.
      this.timings = { vaultRead, ...timings, started: Math.round(performance.now() - began) };
      console.debug('Raindown started', this.timings);
      if (report) console.log(report);
    })();
    this.starting.catch(() => this.stop());

    return this.starting;
  }

  stop() {
    this.worker?.terminate();
    this.fail(new Error('Raindown stopped'));
    Object.assign(this, { worker: null, starting: null });
  }

  // A file added or changed in the vault, by its path, which Raindown's sent if it reads it. Before it's started, it's
  // read as it starts.
  async fileChanged(path) {
    if (!this.starting || !mirrored(path)) return;

    const files = [];
    await this.readFile(path, files);
    await this.sendFiles({ changed: files }, files.map(([, bytes]) => bytes));
  }

  // A file or folder removed from the vault, or renamed from the path.
  async fileRemoved(path) {
    if (this.starting) await this.sendFiles({ removed: [path] });
  }

  // Once it's started, as the worker only has Ruby's folders then.
  async sendFiles(files, transfer = []) {
    const { starting } = this;
    if (starting && await starting.then(() => true, () => false)) this.worker?.postMessage({ type: 'files', ...files }, transfer);
  }

  ask(message, timeout, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop(); // Stuck, so the next request starts it again.
        reject(new Error(`Raindown didn't answer within ${timeout / 1000} seconds`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }

  receive({ id, type, error, ...answer }) {
    if (type === 'fetch') return this.fetch(id, answer.request);

    const request = this.pending.get(id);
    if (!request) return;

    this.pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(new Error(error));
    else request.resolve(answer);
  }

  // An endpoint's request, or a node's, through Raindown's fetch service, which Raindown in the worker waits for, sent
  // with Obsidian's requestUrl, which only the main thread has. Like curl in Raindown, it refuses link-local hosts, but it can't pin a name's address, or stop
  // redirects, as curl does.
  async fetch(id, { method, url, headers, body }) {
    let response;
    try {
      const { hostname } = new URL(url);
      if (LINK_LOCAL.test(hostname)) throw new Error(`Raindown can't request link-local addresses, like cloud metadata at ${hostname}`);

      const started = performance.now();
      const received = await this.requestUrl({ url, method, headers, body: body ?? undefined, throw: false });
      const contentType = Object.entries(received.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
      response = {
        body: received.text, status: received.status, headers: received.headers ?? {}, content_type: contentType ?? '',
        milliseconds: Math.round(performance.now() - started)
      };
    } catch (error) {
      response = { error: error.message };
    }
    this.worker?.postMessage({ type: 'fetched', id, response });
  }

  fail(error) {
    this.pending.forEach(({ reject, timer }) => { clearTimeout(timer); reject(error); });
    this.pending.clear();
  }

  // The files Raindown reads in the folder and its folders, as [path, bytes], with each .raindown folder's files' modified
  // times. Obsidian's adapter lists hidden folders too, like .raindown, which the vault leaves out.
  async readFolder(folder, files, nodes) {
    const { files: paths, folders } = await this.app.vault.adapter.list(folder);
    const inNodes = folder.split('/').includes(NODES_FOLDER);
    await Promise.all(paths.map(async (path) => {
      if (inNodes) nodes.set(path, (await this.app.vault.adapter.stat(path))?.mtime);
      if (mirrored(path)) await this.readFile(path, files);
    }));
    const skipped = (path) => SKIPPED_FOLDERS.has(path.split('/').at(-1)) || path === this.app.vault.configDir;
    await Promise.all(folders.filter((path) => !skipped(path)).map((path) => this.readFolder(path, files, nodes)));
  }

  // The note's front matter, as [path, front matter], when Obsidian's read it, which is {} without any, so Raindown
  // needn't read it, which takes as long as a list: of thousands of notes.
  frontMatter(path) {
    const cache = path.endsWith('.md') && this.app.metadataCache?.getCache(path);
    return cache ? [[path, cache.frontmatter ?? {}]] : [];
  }

  async readFile(path, files) {
    const stat = await this.app.vault.adapter.stat(path);
    if (!stat || stat.size > LARGEST_FILE) return;

    files.push([path, await this.app.vault.adapter.readBinary(path)]);
  }

  // Whether a file in a .raindown folder was added, changed or removed since Raindown started, which Obsidian doesn't
  // say, as they're hidden.
  async nodesChanged() {
    if (!this.nodes) return false;

    const now = new Map();
    for (const folder of new Set([...this.nodes.keys()].map((path) => path.slice(0, path.indexOf(NODES_FOLDER) + NODES_FOLDER.length)))) {
      if (await this.app.vault.adapter.exists(folder)) await this.readFolder(folder, [], now);
    }
    return now.size !== this.nodes.size || [...now].some(([path, mtime]) => this.nodes.get(path) !== mtime);
  }

  // A file Raindown wrote, through the vault, or its adapter when it's in a hidden folder, which the vault leaves out.
  async writeFile(path, bytes) {
    const { vault } = this.app;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const file = vault.getAbstractFileByPath(path);
    if (file) return vault.modifyBinary(file, buffer);

    const folder = path.split('/').slice(0, -1).join('/');
    if (folder && !await vault.adapter.exists(folder)) await vault.adapter.mkdir(folder);
    if (path.split('/').some((part) => part.startsWith('.'))) return vault.adapter.writeBinary(path, buffer);
    return vault.createBinary(path, buffer);
  }
}

function mirrored(path) {
  return MIRRORED.test(path);
}

module.exports = { RaindownEngine };
