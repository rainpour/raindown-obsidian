'use strict';

// Runs in a Web Worker, after ruby.wasm's browser bundle, which gives it ruby-wasm-wasi, with RubyVM and the WASI
// classes the build adds to it. It starts Ruby once, from the module bin/build packed Raindown into, with the vault
// mirrored at /vault in Ruby's in-memory folder, then writes back each note it's asked to on the Ruby it kept running, so
// Obsidian never waits for it. Ruby can't wait for Obsidian to read a file, so the plugin sends the vault's files ahead,
// and each change to them, and gets back the files Raindown wrote, like a table's CSV. Raindown's told which changed at
// each write-back, and given the front matter Obsidian's already read, so it never reads or checks every note itself.
// Ruby waits on the worker for what it can't do in WebAssembly: an endpoint's request, which Obsidian sends, and a
// project's JavaScript Components, which run here.
const { RubyVM, WASI, OpenFile, File, PreopenDirectory, Directory } = self['ruby-wasm-wasi'];
const ARGS = ['ruby.wasm', '--disable-gems', '-EUTF-8', '-e_=0'];
const REQUEST = 'request.json';
const FRONT_MATTERS = 'front_matters.json';

let root;
let vm;
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

// The module's gzipped, in base64, as main.js has it, and the load path is each gem's, as packed.
async function start({ wasm, loadPaths, files, frontMatters = {} }) {
  const bytes = Uint8Array.from(atob(wasm), (char) => char.charCodeAt(0));
  const unzipped = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  const module = await WebAssembly.compile(await unzipped.arrayBuffer());
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

// The note as Raindown writes it back, with its warnings, running its endpoints with execute, or rendered as Markdown,
// for reading view, and the files it wrote, by their paths in the vault.
async function rewrite({ type, path, markdown, bare, execute }) {
  const request = { path: `/vault/${path}`, markdown, bare, execute, render: type === 'render', changed: [...changes] };
  changes.clear();
  root.dir.contents.set(REQUEST, new File(new TextEncoder().encode(JSON.stringify(request))));
  const answer = JSON.parse((await vm.evalAsync(`RaindownEngine.answer('/${REQUEST}')`)).toString());
  return { ...answer, written: writtenFiles(folderAt(['vault']), '') };
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

// A request of Raindown's for a project's JavaScript Components, as JSON, answered as its NodeJS host answers it.
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
  async call({ id, method, context }) {
    return { value: await components.made[id][method](context) };
  }
};

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
