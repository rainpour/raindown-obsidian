'use strict';

// Runs in a Web Worker, after ruby.wasm's browser bundle, which gives it ruby-wasm-wasi, with RubyVM and the WASI
// classes the build adds to it. It starts Ruby once, from the module without Asyncify where the engine has JSPI, or
// else Asyncify's, with Raindown's files and the vault mirrored in Ruby's in-memory folders, the vault at /vault, then
// writes back each note it's asked to on the Ruby it kept running, so Obsidian never waits for it. Ruby can't wait for
// Obsidian to read a file, so the plugin sends the vault's files ahead, and each change to them, and gets back the
// files Raindown wrote, like a table's CSV. Raindown is told which changed at each write-back, and given the front
// matter Obsidian's already read, so it never reads or checks every note itself. Ruby waits on the worker for what it
// can't do in WebAssembly: an endpoint's request, which Obsidian sends, a project's JavaScript Components, which run
// here, and Raindown's services, for its Ruby and JavaScript nodes, which are answered here, after services.js, which
// bin/build puts before this, from Raindown.
const { RubyVM, WASI, OpenFile, File, PreopenDirectory, Directory } = self['ruby-wasm-wasi'];
const ARGS = ['ruby.wasm', '--disable-gems', '-EUTF-8', '-e_=0'];
const REQUEST = 'request.json';
// The plugin's edition, as Raindown's, which has the same: Components, for beginners, with only Markdown Components, in
// a vault's Components folder, or Raindown itself, as it is.
const RUBY_EDITIONS = { full: '', components: 'Raindown.edition = Raindown::Edition::COMPONENTS' };
const FRONT_MATTERS = 'front_matters.json';

let root;
let vm;
// The vault's files and the front matter Obsidian's read, which the engine reads while Ruby starts, and sends once it
// has, which Ruby's given once Raindown's loaded.
let vaultSent;
const vaultArrived = new Promise((resolve) => { vaultSent = resolve; });
// Whether Ruby's the module without Asyncify, which waits for JavaScript, and switches Fibers, with JSPI, JavaScript
// Promise Integration, where the engine has it, and rb_wasm_jspi_eval, which runs Ruby that can, through
// WebAssembly.promising, which it waits for, rather than evalAsync.
let jspi = false;
let jspiEval;
// RbWasmJSPI, called rather than evaluated, and the code its entry runs, set again only when it changes, as evaluating
// Ruby's source parses and compiles it each time.
let jspiModule;
let entryCode;
// The module without Asyncify's garbage collection, which only collects between requests, with no Ruby on the stack,
// and Ruby's memory, whose size each answer gives, as it never shrinks.
let collectGarbage;
let rubyMemory;
// The vault's name, which its cache is kept under, as every vault's at /vault.
let vaultName = '';
// The data each file had when it was last sent or written, to find those Raindown's written since.
const synced = new WeakMap();
// The files changed in the vault since the last write-back, by their paths in Ruby, including those Raindown wrote, so
// it reads them again, as it doesn't check modified times, which the WASI shim doesn't keep.
const changes = new Set();
// The paths in Ruby's folders it opened to write, or linked, like a file renamed, since the last answer, so only those
// are checked for what Raindown wrote, rather than every file in the vault.
const touched = new Set();
// WASI's flags for creating and truncating a file, and the right to write to it.
const OFLAGS_WRITING = 1 | 8;
const RIGHTS_FD_WRITE = 64n;

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
  if (data.type === 'vault') return vaultSent(data);

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
  collectGarbage?.();
}

// The module's compressed with gzip, in Z85, as main.js has it, which the browser decompresses, and the load path is
// each gem's, as packed. It's the one without Asyncify when the engine sends it, as it has JSPI. Says it's begun, so
// the engine reads the vault meanwhile, rather than before. Answers with how long each step took, in milliseconds from
// the start, as timings.
async function start({ wasm, wasmSize, wasmJspi, wasmJspiSize, loadPaths, rootFiles, rootData, rootDataSize, vault = '', edition = 'full' }) {
  self.postMessage({ type: 'began' });
  const began = performance.now();
  const timings = {};
  const mark = (step) => { timings[step] = Math.round(performance.now() - began); };
  vaultName = vault;
  jspi = Boolean(wasmJspi);
  const bytes = jspi ? fromZ85(wasmJspi, wasmJspiSize) : fromZ85(wasm, wasmSize);
  mark('decoded');
  const decompressing = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TransformStream({ flush: () => mark('decompressed') }));
  const module = await compiled(decompressing);
  mark('compiled');
  root = new PreopenDirectory('/', new Map());
  const [open, link] = [root.path_open.bind(root), root.path_link.bind(root)];
  root.path_open = (dirflags, path, oflags, rights, ...rest) => {
    if (oflags & OFLAGS_WRITING || BigInt(rights) & RIGHTS_FD_WRITE) touched.add(path);
    return open(dirflags, path, oflags, rights, ...rest);
  };
  root.path_link = (path, ...rest) => { touched.add(path); return link(path, ...rest); };
  // Ruby's files, which main.js has, rather than its module, with the js gem's and a /bundle/setup.rb that finds them,
  // one after another, compressed with gzip, in Z85, as the module is, by their paths and sizes.
  const data = new Uint8Array(await new Response(new Blob([fromZ85(rootData, rootDataSize)]).stream()
    .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const bytecode = [];
  let at = 0;
  for (const [file, size] of rootFiles) {
    const parts = file.split('/');
    if (parts[0] === 'bytecode') bytecode.push(`${file.slice('bytecode'.length, -'.yarb'.length)} ${at} ${size}`);
    folderAt(parts.slice(0, -1)).contents.set(parts.at(-1), new File(data.subarray(at, at += size)));
  }
  // Ruby's files as one, with where each file's bytecode is in it, which src/bytecode.rb reads once, rather than
  // opening each.
  root.dir.contents.set('bytecode.bin', new File(data));
  root.dir.contents.set('bytecode.idx', new File(new TextEncoder().encode(bytecode.join('\n'))));
  mark('filesUnpacked');
  const wasi = new WASI([], [], [...[0, 1, 2].map(() => new OpenFile(new File([]))), root], { debug: false });
  const exported = {};
  const addToImports = (imports) => { if (jspi) imports.rb_wasm_jspi = jspiImports(exported); };
  const { vm: started, instance } = await RubyVM.instantiateModule({ module, wasip1: wasi, args: ARGS, addToImports });
  vm = started;
  if (jspi) {
    exported.fiberStart = WebAssembly.promising(instance.exports.rb_wasm_jspi_fiber_start);
    jspiEval = WebAssembly.promising(instance.exports.rb_wasm_jspi_eval);
    instance.exports.rb_wasm_jspi_define();
    collectGarbage = instance.exports.rb_wasm_jspi_gc;
  }
  rubyMemory = instance.exports.memory;
  mark('rubyStarted');
  // A vault's .obsidian folder is how Raindown knows it's one, reading a table's path from its top.
  folderAt(['vault', '.obsidian']);
  // Garbage collection's paused while Raindown loads, which collects twice otherwise, taking about 50 ms in all.
  vm.eval([
    "require 'rbconfig'",
    "require '/engine/bytecode'",
    'GC.disable',
    `$LOAD_PATH.unshift(*${JSON.stringify(loadPaths)})`,
    "require 'engine'",
    "require 'worker'",
    jspi ? JSPI_RUBY : '',
    RUBY_EDITIONS[edition],
    'GC.enable'
  ].join('\n'));
  if (jspi) jspiModule = vm.eval('RbWasmJSPI');
  mark('raindownLoaded');
  const { files, frontMatters = {} } = await vaultArrived;
  syncFiles({ changed: files });
  changes.clear();
  mark('filesCopied');
  const watched = Object.fromEntries(Object.entries(frontMatters).map(([path, frontMatter]) => [`/vault/${path}`, frontMatter]));
  root.dir.contents.set(FRONT_MATTERS, new File(new TextEncoder().encode(JSON.stringify(watched))));
  vm.eval(`RaindownEngine.watch('/${FRONT_MATTERS}')`);
  mark('watching');
  return { ready: true, timings, jspi };
}

// The module, compiled as it's decompressed, where WebAssembly can compile a stream, or else once it's all there.
function compiled(stream) {
  const response = new Response(stream, { headers: { 'Content-Type': 'application/wasm' } });
  if (WebAssembly.compileStreaming) return WebAssembly.compileStreaming(response);

  return response.arrayBuffer().then((buffer) => WebAssembly.compile(buffer));
}

// The note as Raindown writes it back, with its warnings, running its endpoints with execute, or rendered as Markdown,
// for reading view, and the files it wrote, by their paths in the vault. Its timings are each step's end, Ruby's among
// them, in milliseconds from when the worker began it.
async function rewrite({ type, path, markdown, bare, execute }) {
  const began = performance.now();
  const request = { path: `/vault/${path}`, markdown, bare, execute, render: type === 'render', changed: [...changes] };
  changes.clear();
  root.dir.contents.set(REQUEST, new File(new TextEncoder().encode(JSON.stringify(request))));
  const requested = performance.now() - began;
  const json = (await evalWaiting(`RaindownEngine.answer('/${REQUEST}')`)).toString();
  const ruby = performance.now() - began;
  const { timings = {}, ...answer } = JSON.parse(json);
  const rubySteps = Object.fromEntries(Object.entries(timings).map(([step, at]) => [step, requested + at]));
  const written = writtenFiles();
  return {
    ...answer, written, memory: rubyMemory.buffer.byteLength,
    timings: { requested, ...rubySteps, ruby, filesCollected: performance.now() - began }
  };
}

// rb_wasm_jspi's imports, each a WebAssembly.Suspending, which suspends the stack of Ruby that calls it: switch, between
// Fibers, each a stack of its own, until something switches back to the one that called it, resuming the one it
// switches to, or starting a new one's, with rb_wasm_jspi_fiber_start, and await, until the promise Ruby keeps by its
// id, in rbJspiPending, settles, with its value in rbJspiResults, and whether it failed.
function jspiImports(exported) {
  const suspended = new Map();
  const pending = new Map();
  const results = new Map();
  Object.assign(globalThis, { rbJspiPending: pending, rbJspiResults: results });
  return {
    switch: new WebAssembly.Suspending((from, to, start) => {
      const back = new Promise((resolve) => suspended.set(from, resolve));
      queueMicrotask(() => {
        if (start) return exported.fiberStart(to).catch((error) => console.error('Raindown: a Fiber failed', error));

        const resume = suspended.get(to);
        suspended.delete(to);
        resume();
      });
      return back;
    }),
    await: new WebAssembly.Suspending(async (id) => {
      try {
        results.set(id, await pending.get(id));
        return 0;
      } catch (error) {
        results.set(id, error);
        return 1;
      } finally {
        pending.delete(id);
      }
    })
  };
}

// Ruby's side, for the module without Asyncify: RbWasmJSPI.run, which rb_wasm_jspi_eval runs, calls the code it's
// given in a Fiber, as evalAsync does, keeping what it gives or raises, so too deep a stack raises SystemStackError at
// the Fiber's machine stack's end, before JSPI's stack, of 984 KB, overflows, and JS::Object#await waits with RbWasmJSPI.wait, which rb_wasm_jspi_define
// defines, rather than switching to a Fiber that JavaScript resumes, which a stack of JSPI's can't do.
const JSPI_RUBY = `
module RbWasmJSPI
  class << self
    attr_writer :entry

    def run
      @running = true
      @error = nil
      @result = Fiber.new { @entry.call }.resume
    rescue Exception => e
      @error = e
    ensure
      @running = false
    end

    def running? = @running

    def take
      raise @error if @error

      @result
    end
  end
end

class JS::PromiseScheduler
  def await(promise)
    raise 'JS::Object#await can be called only from RbWasmJSPI.run' unless RbWasmJSPI.running?

    id = (@jspi_id = (@jspi_id || 0) + 1)
    JS.global[:rbJspiPending].call(:set, id, promise)
    failed = RbWasmJSPI.wait(id)
    results = JS.global[:rbJspiResults]
    value = results.call(:get, id)
    results.call(:delete, id)
    raise JS::Error.new(value) if failed

    value
  end
end
`;

// Ruby's value for code that can wait for JavaScript: through rb_wasm_jspi_eval without Asyncify, or evalAsync.
async function evalWaiting(code) {
  if (!jspi) return vm.evalAsync(code);

  if (code !== entryCode) vm.eval(`RbWasmJSPI.entry = -> { ${code} }`);
  entryCode = code;
  await jspiEval();
  return jspiModule.call('take');
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
  // Each call makes its component the first time, and answers apart, so one that throws doesn't fail the others. The
  // metadata the calls share, every file's front matter, comes once, and goes in each one's context.
  async call({ calls, metadata }) {
    const answers = calls.map(async ({ id, name, args, props, method, context, root: projectRoot }) => {
      try {
        components.made[id] ??= new components.classes[name](props, ...args);
        return { value: await components.made[id][method]({ ...context, metadata, raindown: raindownServices(projectRoot, serviceAnswer) }) };
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    });
    return { answers: await Promise.all(answers) };
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
    touched.add(parts.concat(name).join('/'));
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

// The files Raindown opened to write, or linked, that it wrote since they were last sent or written, like a CSV table:
// made or changed, as [path in the vault, bytes].
function writtenFiles() {
  const paths = [...touched].map((path) => path.split('/').filter(Boolean).join('/')).filter((path) => path.startsWith('vault/'));
  touched.clear();
  return [...new Set(paths)].flatMap((path) => {
    const entry = entryAt(path);
    if (!(entry instanceof File) || synced.get(entry) === entry.data) return [];

    synced.set(entry, entry.data);
    changes.add(`/${path}`);
    return [[path.slice('vault/'.length), entry.data.slice()]];
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
