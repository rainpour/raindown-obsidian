'use strict';

// Runs in a Web Worker, after ruby.wasm's browser bundle, which gives it ruby-wasm-wasi, with RubyVM and the WASI
// classes the build adds to it. It starts Ruby once, from the module bin/build packed Raindown into, with the vault
// mirrored at /vault in Ruby's in-memory folder, then writes back each note it's asked to on the Ruby it kept running, so
// Obsidian never waits for it. Ruby can't wait for Obsidian to read a file, so the plugin sends the vault's files ahead,
// and each change to them, and gets back the files Raindown wrote, like a table's CSV. Raindown's told which changed at
// each write-back, and given the front matter Obsidian's already read, so it never reads or checks every note itself.
// Ruby waits on the worker for what it can't do in WebAssembly: an endpoint's request, which Obsidian sends, a
// project's JavaScript Components, which run here, and Raindown's services, for its Ruby and JavaScript nodes, which
// are answered here, after services.js, which bin/build puts before this, from Raindown.
const { RubyVM, WASI, OpenFile, File, PreopenDirectory, Directory } = self['ruby-wasm-wasi'];
const ARGS = ['ruby.wasm', '--disable-gems', '-EUTF-8', '-e_=0'];
const REQUEST = 'request.json';
const FRONT_MATTERS = 'front_matters.json';

let root;
let vm;
// The vault's name, which its cache is kept under, as every vault's at /vault.
let vaultName = '';
// The data each file had when it was last sent or written, to find those Raindown's written since.
const synced = new WeakMap();
// The files changed in the vault since the last write-back, by their paths in Ruby, including those Raindown wrote, so
// it reads them again, as it doesn't check modified times, which the WASI shim doesn't keep.
const changes = new Set();

// Endpoints' requests sent to Obsidian, by their ids, waiting for their responses.
const fetches = new Map();
let nextFetch = 1;
// Each project's JavaScript Components, by name, and those made, by Ruby's id for them.
const components = { classes: {}, made: {} };
// Requests are answered one at a time, as Ruby can wait in the middle of one, for an endpoint's response, and must
// finish it before the next starts. Responses to its own requests come straight back.
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  if (data.type === 'fetched') return fetched(data);

  queue = queue.then(() => answer(data));
};

async function answer(data) {
  try {
    if (data.type === 'start') self.postMessage({ id: data.id, ...await start(data) });
    if (data.type === 'files') syncFiles(data);
    if (data.type === 'rewrite' || data.type === 'render') self.postMessage({ id: data.id, ...await rewrite(data) });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
}

// The module's compressed with xz, in Z85, as main.js has it, which xz-decompress, before this, decompresses, and the
// load path is each gem's, as packed.
async function start({ wasm, wasmSize, loadPaths, files, frontMatters = {}, vault = '' }) {
  vaultName = vault;
  const bytes = fromZ85(wasm, wasmSize);
  const module = await compiled(new self['xz-decompress'].XzReadableStream(new Blob([bytes]).stream()));
  root = new PreopenDirectory('/', new Map());
  const wasi = new WASI([], [], [...[0, 1, 2].map(() => new OpenFile(new File([]))), root], { debug: false });
  ({ vm } = await RubyVM.instantiateModule({ module, wasip1: wasi, args: ARGS }));
  // A vault's .obsidian folder is how Raindown knows it's one, reading a table's path from its top.
  folderAt(['vault', '.obsidian']);
  syncFiles({ changed: files });
  changes.clear();
  vm.eval([
    "require 'rbconfig'",
    "require '/engine/bytecode'",
    `$LOAD_PATH.unshift(*${JSON.stringify(loadPaths)})`,
    "require 'engine'",
    "require 'worker'"
  ].join('\n'));
  const watched = Object.fromEntries(Object.entries(frontMatters).map(([path, frontMatter]) => [`/vault/${path}`, frontMatter]));
  root.dir.contents.set(FRONT_MATTERS, new File(new TextEncoder().encode(JSON.stringify(watched))));
  vm.eval(`RaindownEngine.watch('/${FRONT_MATTERS}')`);
  return { ready: true };
}

// The module, compiled as it's decompressed, where WebAssembly can compile a stream, or else once it's all there.
function compiled(stream) {
  const response = new Response(stream, { headers: { 'Content-Type': 'application/wasm' } });
  if (WebAssembly.compileStreaming) return WebAssembly.compileStreaming(response);

  return response.arrayBuffer().then((buffer) => WebAssembly.compile(buffer));
}

// The note as Raindown writes it back, with its warnings, running its endpoints with execute, or rendered as Markdown,
// for reading view, and the files it wrote, by their paths in the vault.
async function rewrite({ type, path, markdown, bare, execute }) {
  const request = { path: `/vault/${path}`, markdown, bare, execute, render: type === 'render', changed: [...changes] };
  changes.clear();
  root.dir.contents.set(REQUEST, new File(new TextEncoder().encode(JSON.stringify(request))));
  const answer = JSON.parse((await vm.evalAsync(`RaindownEngine.answer('/${REQUEST}')`)).toString());
  return { ...answer, written: writtenFiles(folderAt(['vault']), '') };
}

// Z85's bytes, cut to their size, as bin/build pads them to a multiple of 4.
const Z85 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
function fromZ85(text, size) {
  const digits = new Uint8Array(128);
  for (let digit = 0; digit < 85; digit++) digits[Z85.charCodeAt(digit)] = digit;
  const bytes = new Uint8Array(text.length / 5 * 4);
  const view = new DataView(bytes.buffer);
  for (let at = 0, to = 0; at < text.length; at += 5, to += 4) {
    let value = 0;
    for (let place = at; place < at + 5; place++) value = value * 85 + digits[text.charCodeAt(place)];
    view.setUint32(to, value);
  }
  return bytes.subarray(0, size);
}

// An endpoint's request, as JSON, which Obsidian sends, as only its main thread can, resolving with its response, as
// JSON, which Ruby waits for.
globalThis.raindownFetch = (request) => new Promise((resolve) => {
  const id = nextFetch++;
  fetches.set(id, resolve);
  self.postMessage({ type: 'fetch', id, request: JSON.parse(request) });
});

function fetched({ id, response }) {
  fetches.get(id)?.(JSON.stringify(response));
  fetches.delete(id);
}

// A request of Raindown's for a project's JavaScript Components, as JSON, answered as its QuickJS host answers it.
globalThis.raindownComponents = async (message) => {
  const request = JSON.parse(message);
  try {
    return JSON.stringify(await componentRequests[request.op](request));
  } catch (error) {
    return JSON.stringify({ error: String(error?.message ?? error) });
  }
};

const componentRequests = {
  // Every exported class with rewrite is a component, named by its export, or by its class for a default export.
  // Each file's imported from its text, so it can't import others.
  async load({ folder }) {
    for (const [name, file] of folderAt(folder.split('/')).contents) {
      if (!/\.m?js$/.test(name) || !(file instanceof File)) continue;

      const exports = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(new TextDecoder().decode(file.data))}`);
      for (const [exported, value] of Object.entries(exports)) {
        if (typeof value?.prototype?.rewrite === 'function') components.classes[exported === 'default' ? value.name : exported] = value;
      }
    }
    return { nodes: Object.entries(components.classes).map(([name, node]) => ({ name, render: typeof node.prototype.render === 'function' })) };
  },
  new({ id, name, args, props }) {
    components.made[id] = new components.classes[name](props, ...args);
    return {};
  },
  async call({ id, method, context, root: projectRoot }) {
    return { value: await components.made[id][method]({ ...context, raindown: raindownServices(projectRoot, serviceAnswer) }) };
  }
};

// Raindown's services, as Raindown::Services answers them on the desktop, by a project's root in Ruby, like /vault,
// over the vault's copy here, which has the files Raindown reads, and Obsidian, which fetches. A file written goes back
// to the vault with the write-back's answer, like a table's CSV. Ruby nodes ask through raindownService, and
// JavaScript ones straight from their raindown.
const services = {
  async fetch(_root, url, { method, headers, body } = {}) {
    const request = { url, method: (method ?? 'GET').toUpperCase(), headers: headers ?? {}, body: body ?? null };
    const response = JSON.parse(await raindownFetch(JSON.stringify(request)));
    if (response.error) throw new Error(response.error);

    return { status: response.status, headers: response.headers, body: response.body };
  },
  read(projectRoot, path) {
    const file = entryAt(inside(projectRoot, path));
    if (!(file instanceof File)) throw new Error(`There's no ${path}`);

    return new TextDecoder().decode(file.data);
  },
  list(projectRoot, pattern = '**/*') {
    const matching = globPattern(pattern);
    return filesIn(entryAt(projectRoot), '').filter((path) => matching.test(path)).sort();
  },
  write(projectRoot, path, text) {
    const parts = inside(projectRoot, path).split('/').filter(Boolean);
    const name = parts.pop();
    const folder = folderAt(parts);
    let file = folder.contents.get(name);
    if (!(file instanceof File)) {
      file = new File([]);
      folder.contents.set(name, file);
    }
    file.data = new TextEncoder().encode(text);
    return null;
  },
  async cache_get(projectRoot, key) {
    const kept = await stored((await cache('readonly')).get(cacheKey(projectRoot, key)));
    if (!kept) return null;
    if (kept.until && Date.now() > kept.until) return null;

    return kept.value;
  },
  async cache_set(projectRoot, key, value, seconds = null) {
    let until = null;
    if (seconds !== null) until = Date.now() + seconds * 1000;
    await stored((await cache('readwrite')).put({ until, value }, cacheKey(projectRoot, key)));
    return null;
  },
  git() {
    throw new Error("git isn't available in Obsidian");
  }
};

async function serviceAnswer(projectRoot, name, args) {
  if (!Object.hasOwn(services, name)) throw new Error(`There's no ${name} service`);

  return services[name](projectRoot, ...args);
}

// A Ruby node's service, as JSON of { value } or { error }, which Ruby waits for.
globalThis.raindownService = async (projectRoot, name, args) => {
  try {
    return JSON.stringify({ value: (await serviceAnswer(projectRoot, name, JSON.parse(args))) ?? null });
  } catch (error) {
    return JSON.stringify({ error: String(error?.message ?? error) });
  }
};

// The path, from the project's root, as a path in Ruby, which must be inside the project.
function inside(projectRoot, path) {
  let full = `${projectRoot}/${path}`;
  if (String(path).startsWith('/')) full = String(path);
  const parts = [];
  for (const part of full.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  const resolved = `/${parts.join('/')}`;
  if (!resolved.startsWith(`${projectRoot.replace(/\/+$/, '')}/`)) throw new Error(`${path} is outside the project`);

  return resolved;
}

// The file or folder at a path in Ruby, like /vault/notes/a.md, or nothing.
function entryAt(path) {
  return path.split('/').filter(Boolean).reduce((entry, part) => entry?.contents?.get(part), root.dir);
}

// The paths of the files in a folder and its folders, from it.
function filesIn(folder, path) {
  if (!(folder instanceof Directory)) return [];

  return [...folder.contents].flatMap(([name, entry]) => {
    const inner = [path, name].filter(Boolean).join('/');
    if (entry instanceof Directory) return filesIn(entry, inner);
    return [inner];
  });
}

// A glob, like notes/*.md or **/*.csv, as a pattern matching paths, which, like Ruby's, only matches a hidden file or
// folder when it starts with a dot.
function globPattern(glob) {
  const segments = glob.split('/');
  if (segments.at(-1) === '**') segments[segments.length - 1] = '*';
  return new RegExp(`^${segments.map(globSegment).join('').replace(/\/$/, '')}$`);
}

function globSegment(segment) {
  if (segment === '**') return '(?:(?!\\.)[^/]*/)*';

  const chars = [...segment].map((char) => {
    if (char === '*') return '[^/]*';
    if (char === '?') return '[^/]';
    return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('');
  if (segment.startsWith('.')) return `${chars}/`;
  return `(?!\\.)${chars}/`;
}

// The vault's cache, in IndexedDB, which lasts across restarts, for each project and vault.
let cacheDatabase;
async function cache(mode) {
  cacheDatabase ??= stored(Object.assign(indexedDB.open('raindown-cache', 1), {
    onupgradeneeded: ({ target }) => target.result.createObjectStore('kept')
  }));
  return (await cacheDatabase).transaction('kept', mode).objectStore('kept');
}

function cacheKey(projectRoot, key) {
  return JSON.stringify([vaultName, projectRoot, key]);
}

function stored(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Files the plugin read from the vault, or changed in it, by their paths in it, and those it removed.
function syncFiles({ changed = [], removed = [] }) {
  for (const [path, bytes] of changed) {
    const parts = path.split('/');
    const name = parts.pop();
    const folder = folderAt(['vault', ...parts]);
    let file = folder.contents.get(name);
    if (!(file instanceof File)) {
      file = new File([]);
      folder.contents.set(name, file);
    }
    file.data = new Uint8Array(bytes);
    synced.set(file, file.data);
    changes.add(`/vault/${path}`);
  }
  for (const path of removed) {
    const parts = path.split('/');
    const name = parts.pop();
    const folder = folderAt(['vault', ...parts]);
    folder.contents.delete(name);
    changes.add(`/vault/${path}`);
  }
}

// The files in the folder, and in its folders, that Raindown wrote since they were last sent or written, like a CSV
// table: made or changed, as [path, bytes].
function writtenFiles(folder, path) {
  return [...folder.contents].flatMap(([name, entry]) => {
    const inside = path ? `${path}/${name}` : name;
    if (entry instanceof Directory) return writtenFiles(entry, inside);
    if (synced.get(entry) === entry.data) return [];

    synced.set(entry, entry.data);
    changes.add(`/vault/${inside}`);
    return [[inside, entry.data.slice()]];
  });
}

// The folder at the path, like ['vault', 'notes'], made with the folders it's in when it isn't there.
function folderAt(parts) {
  return parts.filter(Boolean).reduce((folder, part) => {
    if (!(folder.contents.get(part) instanceof Directory)) {
      const child = new Directory(new Map());
      child.parent = folder;
      folder.contents.set(part, child);
    }
    return folder.contents.get(part);
  }, root.dir);
}
