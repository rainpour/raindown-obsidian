'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

// The plugin requires 'obsidian', which only Obsidian provides, so it's given the stub instead.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return path.join(__dirname, 'obsidian.js');
  if (request.startsWith('@codemirror/')) return path.join(__dirname, 'codemirror.js');

  return resolve.call(this, request, ...rest);
};

const RaindownPlugin = require('../src/plugin');
const { RaindownEngine } = require('../src/engine');
const { Notice } = require('./obsidian');

// A stand-in for Raindown, filling in tables of contents, or answering as it's given.
function fakeEngine(answer = (markdown) => ({ output: markdown.replace('<!-- :toc -->', '- [A](#a)\n<!-- :toc -->'), warnings: [] })) {
  return {
    asked: [],
    async rewrite(request) {
      this.asked.push(request);
      return answer(request.markdown);
    },
    start: async () => {},
    stop: () => {},
    fileChanged: () => {},
    fileRemoved: () => {}
  };
}

// An open note's editor, which Obsidian saves to the vault on its own.
// A stand-in for Obsidian's editor, with positions as { line, ch } like its own, and changes that span lines, made
// against the text as it was before any of them, like a CodeMirror transaction's.
function fakeEditor(text) {
  return {
    text,
    getValue() { return this.text; },
    getLine(line) { return this.text.split('\n')[line]; },
    offsetToPos(offset) {
      const before = this.text.slice(0, offset).split('\n');
      return { line: before.length - 1, ch: before.at(-1).length };
    },
    posToOffset({ line, ch }) {
      return this.text.split('\n').slice(0, line).reduce((offset, text) => offset + text.length + 1, 0) + ch;
    },
    cursor: { line: 0, ch: 0 },
    getCursor() { return this.cursor; },
    setSelection(_anchor, head) { this.cursor = head; },
    replaceRange(replacement, from, to = from) { this.transaction({ changes: [{ from, to, text: replacement }] }); },
    transaction({ changes }) {
      const offsets = changes.map(({ from, to = from, text: replacement }) => [this.posToOffset(from), this.posToOffset(to), replacement]);
      for (const [from, to, replacement] of offsets.sort(([a], [b]) => b - a)) {
        this.text = this.text.slice(0, from) + replacement + this.text.slice(to);
      }
    }
  };
}

async function plugin({ content = '', typed, editor, engine = fakeEngine() } = {}) {
  let current = content;
  const app = {
    vault: {
      adapter: {},
      read: async () => current,
      process: async (_file, change) => { current = change(typed ?? current); },
      on: () => {}
    },
    workspace: {
      onLayoutReady: () => {},
      updateOptions: () => {},
      on: () => {},
      getLeavesOfType: () => (editor ? [{ view: { file: { path: 'note.md' }, editor } }] : [])
    }
  };
  const raindown = new RaindownPlugin(app);
  await raindown.onload();
  raindown.engine = engine;

  return { raindown, engine, file: { path: 'note.md', extension: 'md' }, current: () => current };
}

test('only applies what Raindown wrote back to the note it was given', () => {
  assert.equal(RaindownPlugin.applyRewrite('a', 'a', 'b'), 'b');
  assert.equal(RaindownPlugin.applyRewrite('a and more', 'a', 'b'), 'a and more');
});

test("finds a table's file in the vault without Node's path, which phones don't have", () => {
  assert.equal(RaindownPlugin.vaultPath('', 'data.csv'), 'data.csv');
  assert.equal(RaindownPlugin.vaultPath('notes', '../data/./a.csv'), 'data/a.csv');
  assert.equal(RaindownPlugin.vaultPath('notes', '../../a.csv'), '../a.csv');
  assert.equal(RaindownPlugin.vaultPath('notes/a', '..'), 'notes');
});

test('only starts Raindown for notes with directives', () => {
  assert.ok(RaindownPlugin.hasDirectives('# A\n\n<!-- toc: -->\n'));
  assert.ok(RaindownPlugin.hasDirectives('---\nraindown: true\n---\n'));
  assert.ok(!RaindownPlugin.hasDirectives('# A\n\n<!-- a note -->\nJust text.\n'));
  assert.ok(!RaindownPlugin.hasDirectives('# A\n\ntoc:\n'));
  assert.ok(RaindownPlugin.hasDirectives('# A\n\ntoc:\n', { bareSyntax: true }));
});

test('writes back to the note, by its path in the vault, and not again for the save that makes', async () => {
  const content = '# A\n\n<!-- toc: -->\n<!-- :toc -->\n';
  const { raindown, engine, file, current } = await plugin({ content });

  await raindown.writeBack(file);
  assert.equal(current(), '# A\n\n<!-- toc: -->\n- [A](#a)\n<!-- :toc -->\n');
  assert.deepEqual(engine.asked, [{ path: 'note.md', markdown: content, bare: false }]);

  await raindown.writeBack(file);
  assert.equal(engine.asked.length, 1);
  assert.equal(raindown.status.text, '');
});

test('keeps what was typed while Raindown ran', async () => {
  const typed = '# A\n\n<!-- toc: -->\n<!-- :toc -->\n\nMore\n';
  const { raindown, file, current } = await plugin({ content: '# A\n\n<!-- toc: -->\n<!-- :toc -->\n', typed });

  await raindown.writeBack(file);
  assert.equal(current(), typed);
});

test("sends Raindown each file added, renamed or removed once the vault's loaded, with a folder's files", async () => {
  const handlers = {};
  const sent = [];
  const engine = { ...fakeEngine(), fileChanged: (file) => sent.push(['changed', file]), fileRemoved: (file) => sent.push(['removed', file]) };
  const app = {
    vault: { on: (event, handler) => { handlers[event] = handler; } },
    workspace: { onLayoutReady: (ready) => ready(), on: () => {}, getLeavesOfType: () => [] }
  };
  const raindown = new RaindownPlugin(app);
  raindown.loadData = async () => ({ writeBack: false }); // So Raindown isn't started.
  await raindown.onload();
  raindown.engine = engine;

  handlers.create({ path: 'notes', children: [{ path: 'notes/a.md' }] });
  handlers.rename({ path: 'b.md' }, 'a.md');
  handlers.delete({ path: 'c.csv' });
  handlers.modify({ path: 'd.csv', extension: 'csv' });
  assert.deepEqual(sent, [['changed', 'notes'], ['changed', 'notes/a.md'], ['removed', 'a.md'], ['changed', 'b.md'], ['removed', 'c.csv'], ['changed', 'd.csv']]);
});

test("shows Raindown's errors in the status bar, and in a notice from a command", async () => {
  const engine = fakeEngine(() => { throw new Error('/vault/note.md: Missing end tag'); });
  const { raindown, file } = await plugin({ content: '<!-- toc: -->\n', engine });

  await raindown.writeBack(file);
  assert.equal(raindown.status.text, 'Raindown: Missing end tag');

  await raindown.writeBack(file, { notify: true });
  assert.equal(Notice.messages.at(-1), 'Missing end tag');

  raindown.engine = fakeEngine(() => ({ output: '', warnings: [] }));
  await raindown.writeBack(file, { notify: true });
  assert.equal(Notice.messages.at(-1), "Raindown didn't print the note back, so it's left as it is");
});

test('changes an open note in its editor, with unsaved typing, only where it changed', async () => {
  const editor = fakeEditor('# A\n\n<!-- toc: -->\n<!-- :toc -->\n\nTyped, not saved\n');
  const { raindown, file, current } = await plugin({ content: '# A\n', editor });

  await raindown.writeBack(file);
  assert.equal(editor.text, '# A\n\n<!-- toc: -->\n- [A](#a)\n<!-- :toc -->\n\nTyped, not saved\n');
  assert.equal(current(), '# A\n');

  assert.deepEqual(RaindownPlugin.changedRange('abc', 'aXc'), { from: 1, to: 2, text: 'X' });
  assert.deepEqual(RaindownPlugin.changedRange('aa', 'aaa'), { from: 2, to: 2, text: 'a' });
});

// A stand-in for the worker that runs Raindown, keeping what it's sent and answering as the function does, or not at all.
function fakeWorker(answer) {
  return class {
    static made = [];

    constructor() {
      this.sent = [];
      this.constructor.made.push(this);
    }

    postMessage(message) {
      this.sent.push(message);
      const answered = message.id && answer(message);
      if (answered) setTimeout(() => this.onmessage({ data: { id: message.id, ...answered } }), 0);
    }

    terminate() { this.terminated = true; }
  };
}

// A vault of the files, by path, as Obsidian's API has it, with what's made through the vault rather than its adapter.
function fakeVault(files) {
  const mtimes = {};
  const made = [];
  const decode = (bytes) => new TextDecoder().decode(bytes);
  const under = (folder) => Object.keys(files).filter((file) => !folder || file.startsWith(`${folder}/`));
  const vault = {
    configDir: '.obsidian',
    adapter: {
      list: async (folder) => {
        const depth = folder ? folder.split('/').length + 1 : 1;
        const paths = under(folder).map((file) => file.split('/').slice(0, depth).join('/'));
        return { files: paths.filter((p) => p in files), folders: [...new Set(paths.filter((p) => !(p in files)))] };
      },
      stat: async (file) => (file in files ? { size: files[file].length, mtime: mtimes[file] ?? 1 } : null),
      readBinary: async (file) => new TextEncoder().encode(files[file]).buffer,
      exists: async (file) => file in files || under(file).length > 0,
      mkdir: async () => {},
      writeBinary: async (file, bytes) => { files[file] = decode(bytes); }
    },
    getAbstractFileByPath: (file) => (file in files ? { path: file } : null),
    modifyBinary: async ({ path: file }, bytes) => { files[file] = decode(bytes); },
    createBinary: async (file, bytes) => { made.push(file); files[file] = decode(bytes); }
  };
  return { vault, files, mtimes, made };
}

function fakeRuntime() {
  return { wasm: 'AA==', worker: '', loadPaths: ['/engine'] };
}

const bytes = (text) => new TextEncoder().encode(text);

test("sends Raindown the vault's files it reads as it starts, with the front matter Obsidian's read, leaving out others", async () => {
  const { vault } = fakeVault({
    'note.md': '# A', 'data/a.csv': 'a', '.raindown/shout.rb': 'class Shout', '.obsidian/app.json': '{}', '.git/HEAD.md': 'x', 'a.png': 'png'
  });
  const Worker = fakeWorker(() => ({ ready: true }));
  const metadataCache = { getCache: (file) => (file === 'note.md' ? { frontmatter: { tags: ['a'] } } : null) };
  const engine = new RaindownEngine({ vault, metadataCache }, { runtime: fakeRuntime, Worker });

  await engine.start();
  const [{ type, files, loadPaths, frontMatters }] = Worker.made[0].sent;
  assert.deepEqual([type, files.map(([file]) => file).sort(), loadPaths], ['start', ['.raindown/shout.rb', 'data/a.csv', 'note.md'], ['/engine']]);
  assert.deepEqual(frontMatters, { 'note.md': { tags: ['a'] } });

  await engine.fileChanged('notes/b.md');
  await engine.fileChanged('a.png');
  engine.fileRemoved('note.md');
  await new Promise((done) => { setTimeout(done, 0); });
  assert.deepEqual(Worker.made[0].sent.slice(1).map(({ changed, removed }) => [changed?.map(([file]) => file), removed]), [
    [[], undefined], [undefined, ['note.md']]
  ]);
});

test('writes the files Raindown wrote to the vault, and hidden ones through its adapter', async () => {
  const { vault, files, made } = fakeVault({ 'note.md': '# A', 'data.csv': 'a' });
  const written = [['data.csv', bytes('b')], ['new/c.csv', bytes('c')], ['.raindown/data/d.csv', bytes('d')]];
  const Worker = fakeWorker(({ type }) => (type === 'start' ? { ready: true } : { output: '# A', warnings: [], written }));
  const engine = new RaindownEngine({ vault }, { runtime: fakeRuntime, Worker });

  const answer = await engine.rewrite({ path: 'note.md', markdown: '# A', bare: false }, { timeout: 1000 });
  assert.equal(answer.output, '# A');
  assert.deepEqual([files['data.csv'], files['new/c.csv'], files['.raindown/data/d.csv'], made], ['b', 'c', 'd', ['new/c.csv']]);
  assert.deepEqual(Worker.made[0].sent[1], { id: 2, type: 'rewrite', path: 'note.md', markdown: '# A', bare: false });
});

test('starts Raindown again when a file in a .raindown folder changes, so its nodes load again', async () => {
  const { vault, files, mtimes } = fakeVault({ 'note.md': '# A', '.raindown/shout.rb': 'class Shout' });
  const Worker = fakeWorker(({ type }) => (type === 'start' ? { ready: true } : { output: '', warnings: [], written: [] }));
  const engine = new RaindownEngine({ vault }, { runtime: fakeRuntime, Worker });
  const rewrite = () => engine.rewrite({ path: 'note.md', markdown: '' }, { timeout: 1000 });

  await rewrite();
  await rewrite();
  assert.equal(Worker.made.length, 1);

  mtimes['.raindown/shout.rb'] = 2;
  await rewrite();
  files['.raindown/whisper.md'] = 'quiet';
  await rewrite();
  assert.deepEqual(Worker.made.map(({ terminated }) => Boolean(terminated)), [true, true, false]);
});

test("stops Raindown when it doesn't answer in time, and starts it again for the next note", async () => {
  const { vault } = fakeVault({ 'note.md': '# A' });
  let answers = false;
  const Worker = fakeWorker(({ type }) => (type === 'start' ? { ready: true } : answers && { output: 'B', warnings: [], written: [] }));
  const engine = new RaindownEngine({ vault }, { runtime: fakeRuntime, Worker });
  const rewrite = () => engine.rewrite({ path: 'note.md', markdown: '# A' }, { timeout: 20 });

  await assert.rejects(rewrite(), /^Error: Raindown didn't answer within 0.02 seconds$/);
  answers = true;
  assert.equal((await rewrite()).output, 'B');
  assert.deepEqual(Worker.made.map(({ terminated }) => Boolean(terminated)), [true, false]);
});

test("says Raindown's error, and why it couldn't start", async () => {
  const { vault } = fakeVault({ 'note.md': '# A' });
  const Worker = fakeWorker(({ type }) => (type === 'start' ? { ready: true } : { error: '/vault/note.md: Missing end tag' }));
  const engine = new RaindownEngine({ vault }, { runtime: fakeRuntime, Worker });
  await assert.rejects(engine.rewrite({ path: 'note.md', markdown: '' }, { timeout: 1000 }), /Missing end tag/);

  const broken = new RaindownEngine({ vault }, { runtime: fakeRuntime, Worker: fakeWorker(() => ({ error: 'no WebAssembly' })) });
  await assert.rejects(broken.rewrite({ path: 'note.md', markdown: '' }, { timeout: 1000 }), /^Error: no WebAssembly$/);
});

function highlighted(text, options) {
  return RaindownPlugin.directiveTokens(text, options).map(({ from, to, type }) => [text.slice(from, to), type]);
}

test('highlights directives in comments, with their end tags, and in <{ }>', () => {
  assert.deepEqual(highlighted("<!-- list: folder: 'notes' limit=3 -->\n<!-- :list -->\n"), [
    ['list:', 'name'], ['folder:', 'prop'], ["'notes'", 'string'], ['limit=', 'prop'], ['3', 'number'], [':list', 'end']
  ]);
  assert.deepEqual(highlighted('<{ list: page folder: {dir} }> and <{ :toc }>'), [
    ['<{', 'delimiter'], ['list:', 'name'], ['page', 'variable'], ['folder:', 'prop'], ['{dir}', 'variable'], ['}>', 'delimiter'],
    ['<{', 'delimiter'], [':toc', 'end'], ['}>', 'delimiter']
  ]);
  assert.deepEqual(highlighted('<!-- a note --> and <!-- Changelog::Short: -->'), [['Changelog::Short:', 'name']]);
});

test('highlights bare directives only where they write back, and not in code or front matter', () => {
  const note = 'toc:\n:toc\nendpoint: :x\nfolder: notes here\n';
  assert.deepEqual(highlighted(note), []);
  assert.deepEqual(highlighted(note, { bare: true }), [
    ['toc:', 'name'], [':toc', 'self-closing'], ['endpoint:', 'name'], [':x', 'flag'], ['folder:', 'name']
  ]);
  assert.deepEqual(highlighted('---\nraindown: true\ntoc: 1\n---\ntoc:\n'), [['toc:', 'name']]);
  assert.deepEqual(highlighted('```\n<!-- toc: -->\n```\n`<{ :toc }>` <!-- :toc -->\n'), [[':toc', 'end']]);
});

test('writes back every note with directives, and says how many changed', async () => {
  const notes = { 'a.md': '# A\n\n<!-- toc: -->\n<!-- :toc -->\n', 'b.md': '# B\n', 'c.md': '# C\n\n<!-- list: -->\n' };
  const { raindown } = await plugin();
  const files = Object.keys(notes).map((name) => ({ path: name, extension: 'md' }));
  Object.assign(raindown.app.vault, {
    getMarkdownFiles: () => files,
    cachedRead: async (file) => notes[file.path],
    read: async (file) => notes[file.path],
    process: async (file, change) => { notes[file.path] = change(notes[file.path]); }
  });

  await raindown.writeBackAll(RaindownPlugin.hasDirectives, { notify: true });
  assert.equal(notes['a.md'], '# A\n\n<!-- toc: -->\n- [A](#a)\n<!-- :toc -->\n');
  assert.equal(Notice.messages.at(-1), 'Wrote back 1 note');
});

test("finds the line of Raindown's error, to underline it", () => {
  assert.equal(RaindownPlugin.errorLine('raindown: n.md: <!-- toc: --> on line 7 needs <!-- :toc -->'), 7);
  assert.equal(RaindownPlugin.errorLine('raindown: n.md: wrong number of arguments'), null);
});

test("completes directive names, with the project's own nodes", async () => {
  const { raindown } = await plugin();
  raindown.app.vault.adapter = {
    exists: async (folder) => folder === '.raindown',
    list: async () => ({ files: ['.raindown/BookCard.md', '.raindown/Changelog.rb', '.raindown/config.yml'] })
  };
  raindown.app.metadataCache = { getFileCache: () => ({ frontmatter: { raindown: true } }) };
  const suggest = new (RaindownPlugin.DirectiveSuggest)(raindown.app, raindown);
  const editor = (line) => ({ getLine: () => line });
  const note = { path: 'notes/a.md', parent: { path: 'notes' } };

  assert.deepEqual(suggest.onTrigger({ line: 0, ch: 7 }, editor('<!-- to'), note), { start: { line: 0, ch: 5 }, end: { line: 0, ch: 7 }, query: 'to' });
  assert.equal(suggest.onTrigger({ line: 0, ch: 2 }, editor('to'), note).query, 'to');
  assert.equal(suggest.onTrigger({ line: 0, ch: 9 }, editor('A note to'), note), null);
  assert.deepEqual(await suggest.getSuggestions({ query: 'c', file: note }), ['chart', 'Changelog']);
  assert.deepEqual(await suggest.getSuggestions({ query: 'B', file: note }), ['BookCard']);
  assert.deepEqual(await suggest.getSuggestions({ query: 'ta', file: note }), ['table']);
});

test("doesn't write back lists after it's unloaded", async () => {
  const { raindown, file } = await plugin();
  let writtenBack = false;
  raindown.writeBackAll = async () => { writtenBack = true; };

  raindown.scheduleListsWriteBack(file);
  raindown.onunload();
  await new Promise((resolve) => { setTimeout(resolve, 1100); });

  assert.equal(writtenBack, false);
});

test('writes back a note with only bare directives when Bare syntax is on', async () => {
  const { raindown, file } = await plugin({ content: '# A\n\ntoc:\n' });
  let asked = 0;
  raindown.raindown = async ({ markdown }) => { asked += 1; return { output: markdown, warnings: '' }; };

  await raindown.writeBack(file, { force: true });
  raindown.settings.bareSyntax = true;
  await raindown.writeBack(file, { force: true });

  assert.equal(asked, 1);
});

test("keeps what it writes back out of the editor's undo history", () => {
  const dispatched = [];
  const editor = {
    cm: { dispatch: (transaction) => dispatched.push(transaction) },
    posToOffset: ({ line, ch }) => (line * 10) + ch
  };

  RaindownPlugin.changeOutsideHistory(editor, [{ from: { line: 1, ch: 0 }, to: { line: 1, ch: 3 }, text: 'B' }, { from: { line: 2, ch: 1 }, text: 'C' }]);

  assert.deepEqual(dispatched, [{
    changes: [{ from: 10, to: 13, insert: 'B' }, { from: 21, to: 21, insert: 'C' }],
    annotations: { addToHistory: false }
  }]);
});

test("finds each table's file, where its line ends, and not in code or another directive", () => {
  const note = "<!-- table: 'a.csv' -->\n<!-- :table -->\n\n```md\n<!-- table: 'code.csv' -->\n```\n\n<{ :table 'b.tsv' total: true }>\n<!-- list: folder: 'notes' -->\ntable: 'bare.csv'\n";
  const files = RaindownPlugin.tableFiles(note, {});

  assert.deepEqual(files.map(({ data }) => data), ['a.csv', 'b.tsv']);
  assert.equal(note.slice(0, files[0].at), "<!-- table: 'a.csv' -->");
  assert.deepEqual(RaindownPlugin.tableFiles(note, { bare: true }).map(({ data }) => data), ['a.csv', 'b.tsv', 'bare.csv']);

  const unquoted = 'table: test.csv\n<!-- table: data/my books.csv total: true -->\ntable: raindown/data.csv, total: true\n';
  assert.deepEqual(RaindownPlugin.tableFiles(unquoted, { bare: true }).map(({ data }) => data), ['test.csv', 'data/my books.csv', 'raindown/data.csv']);
});

test("opens a table's file from the project, and says when it isn't there yet", async () => {
  const { raindown } = await plugin();
  const existing = new Set(['notes/.raindown', 'notes/data/books.csv']);
  raindown.app.vault.adapter.exists = async (found) => existing.has(found);
  const opened = [];
  raindown.app.openWithDefaultApp = (found) => opened.push(found);
  const note = { parent: { path: 'notes/2026' } };

  await raindown.openTableFile(note, 'data/books.csv');
  await raindown.openTableFile(note, 'data/missing.csv');
  await raindown.openTableFile({ parent: { path: 'elsewhere' } }, '../../outside.csv');

  assert.deepEqual(opened, ['notes/data/books.csv']);
  assert.equal(await raindown.projectRoot({ parent: { path: 'elsewhere' } }), '');
});

test("shows Raindown's messages without the note's path, and others' from the vault's", async () => {
  const { raindown, file } = await plugin();
  const message = '/vault/note.md: <!-- toc: --> on line 3 needs <!-- :toc -->\n/vault/notes/Bad.md: bad YAML';

  assert.equal(raindown.shortMessage(message, file), '<!-- toc: --> on line 3 needs <!-- :toc -->\nnotes/Bad.md: bad YAML');
  assert.equal(raindown.shortMessage('', file), '');
});

test("finds each directive's line from its name, to leave out of spell checking", () => {
  const note = "Some prose\n<!-- table: data/my books.csv, total: true -->\n- written below\n:toc";
  const lines = RaindownPlugin.directiveLines(note, RaindownPlugin.directiveTokens(note, { bare: true }));

  assert.deepEqual(lines.map(({ from, to }) => note.slice(from, to)), ['table: data/my books.csv, total: true -->', ':toc']);
});

test("knows when the cursor's on a directive's line", () => {
  const note = "# A\n<!-- table: 'a.csv' -->\ntable: b.csv\n```\n<!-- toc: -->\n```\nSummary: text";
  const on = (line, options = {}) => RaindownPlugin.onDirectiveLine(note, { line, ch: 0 }, options);

  assert.deepEqual([0, 1, 2, 4, 6].map((line) => on(line)), [false, true, false, false, false]);
  assert.equal(on(2, { bare: true }), true);
});

test("waits to write back while the cursor's on a directive's line, then writes back once it leaves", async () => {
  const editor = fakeEditor("# A\n<!-- table: 'rtest.csv' -->\n<!-- :table -->\n");
  const { raindown, file } = await plugin({ content: '', editor });
  const asked = [];
  raindown.raindown = async ({ markdown }) => { asked.push(markdown); return { output: markdown, warnings: '' }; };
  const written = [];
  raindown.scheduleWriteBack = (note) => written.push(note.path);

  editor.cursor = { line: 1, ch: 20 };
  assert.equal(await raindown.writeBack(file), false);
  raindown.cursorMoved({ file, editor });
  assert.deepEqual([asked.length, written], [0, []]);

  editor.cursor = { line: 2, ch: 0 };
  raindown.cursorMoved({ file, editor });
  raindown.cursorMoved({ file, editor });
  assert.deepEqual(written, ['note.md']);

  editor.cursor = { line: 1, ch: 20 };
  await raindown.writeBack(file, { notify: true });
  assert.equal(asked.length, 1);
});

test("writes back on Enter on a held directive's line, and leaves Enter alone elsewhere", async () => {
  const editor = fakeEditor("# A\n<!-- table: 'abc/test.csv' -->\n<!-- :table -->\n");
  const { raindown, file } = await plugin({ content: '', editor });
  const asked = [];
  raindown.raindown = async ({ markdown }) => { asked.push(markdown); return { output: markdown, warnings: '' }; };

  editor.cursor = { line: 1, ch: 20 };
  assert.equal(raindown.confirmHeld({ file, editor }), false);
  await raindown.writeBack(file);
  assert.equal(raindown.confirmHeld({ file, editor }), true);
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.equal(asked.length, 1);
  assert.equal(raindown.held.has('note.md'), false);
  assert.equal(raindown.confirmHeld({ file, editor }), false);
});

test("underlines the line of a directive Raindown couldn't run, while writing back the rest", async () => {
  const { raindown, file } = await plugin({ content: "<!-- toc: extra -->\n<!-- :toc -->\n" });
  raindown.raindown = async ({ markdown }) => ({ output: markdown, warnings: "line 1: toc: takes no value, so it can't read \"extra\"" });

  await raindown.writeBack(file, { force: true });

  assert.equal(raindown.errors.get('note.md'), 1);
});

test('finds the start of each line of a table, and no others, with its header, delimiter row and pipes', () => {
  const text = 'A | B\n\n| a | b |\n| - | - |\n  | 1 | 2 |\n|+ | 3 |\n+ a list |\n\nnot | a table |\n';

  const lines = RaindownPlugin.tableLines(text);

  assert.deepEqual(lines.filter(({ type }) => type === 'table').map(({ from }) => text.slice(from).split('\n')[0]), ['| a | b |', '| - | - |', '  | 1 | 2 |', '|+ | 3 |']);
  assert.deepEqual(lines.filter(({ type }) => type === 'table-header').map(({ from, to }) => text.slice(from, to)), ['| a | b |']);
  assert.deepEqual(lines.filter(({ type }) => type === 'table-delimiter').map(({ from, to }) => text.slice(from, to)), ['| - | - |']);
  assert.deepEqual(lines.filter(({ type }) => type === 'table-pipe').map(({ from, to }) => text.slice(from, to)).join(''), '|||||||||');
  assert.deepEqual(lines.filter(({ type }) => type === 'table-expansion').map(({ from, to }) => text.slice(from, to)).join(''), '|+||');
});

test('changes each changed line on its own, last first, so a table lined up again keeps the cursor out of them', () => {
  assert.deepEqual(RaindownPlugin.changedLines('a1\nb\nc1', 'a2\nb\nc2'), [
    { from: { line: 2, ch: 1 }, to: { line: 2, ch: 2 }, text: '2' },
    { from: { line: 0, ch: 1 }, to: { line: 0, ch: 2 }, text: '2' }
  ]);
  assert.equal(RaindownPlugin.changedLines('a', 'a\nb'), null);
});

test('keeps the cursor after the same text as a table is lined up again', () => {
  const before = '| Total | =sum()  |';
  const after = '| Total | =sum() |';

  assert.deepEqual(RaindownPlugin.movedCursor({ line: 0, ch: 16 }, before, after), { line: 0, ch: 16 });
  assert.deepEqual(RaindownPlugin.movedCursor({ line: 0, ch: 7 }, '| Unit  | x |', '| Unit | x |'), { line: 0, ch: 7 });
  assert.deepEqual(RaindownPlugin.movedCursor({ line: 0, ch: 5 }, '| a   b |', '| a b   |'), { line: 0, ch: 4 });
});

test("updates a note's table comments when it's changed since, leaving its other lines alone", async () => {
  const comment = (hash) => `<!-- 1 row · ${hash} -->`;
  const editor = fakeEditor(`${comment('aaa111')}\n| typed more |`);
  const note = { editorFor: () => editor };

  await RaindownPlugin.prototype.applyToNote.call(note, {}, `${comment('aaa111')}\n| typed |`, `${comment('bbb222')}\n| typed |`);

  assert.equal(editor.text, `${comment('bbb222')}\n| typed more |`);
  assert.deepEqual(RaindownPlugin.blockCommentChanges(comment('aaa111'), `${comment('bbb222')}\n${comment('ccc333')}`), []);
});

test('writes a note back one at a time, once more if asked to meanwhile, as it was last asked to', async () => {
  const finished = [];
  const asked = [];
  const note = {
    writing: new Map(),
    writeBackInTurn: RaindownPlugin.prototype.writeBackInTurn,
    writeBack(file, options) { asked.push(options); return new Promise((resolve) => finished.push(resolve)); }
  };

  note.writeBackInTurn({ path: 'a.md' });
  note.writeBackInTurn({ path: 'a.md' });
  note.writeBackInTurn({ path: 'a.md' }, { force: true });
  assert.equal(finished.length, 1);

  finished[0]();
  await new Promise(setImmediate);
  assert.equal(finished.length, 2);
  assert.deepEqual(asked, [{}, { force: true }]);

  finished[1]();
  await new Promise(setImmediate);
  assert.equal(finished.length, 2);
  assert.equal(note.writing.size, 0);
});

test('knows when the cursor is in a table cell starting with =', () => {
  const row = '| Total | =sum(c) | note |';

  assert.equal(RaindownPlugin.inFormulaCell(row, row.indexOf(')')), true);
  assert.equal(RaindownPlugin.inFormulaCell(row, 5), false);
  assert.equal(RaindownPlugin.inFormulaCell(row, row.length - 2), false);
  assert.equal(RaindownPlugin.inFormulaCell('total =sum(c)', 12), false);
});

test('lines up tables like Raindown, keeping alignment markers, escaped pipes and indents, and leaving code alone', () => {
  const { alignTables } = RaindownPlugin;

  assert.equal(alignTables('| Command | Description |\n|-|-|\n| render | Render once |\n| watch | Re-render on save |\n'),
    '| Command | Description       |\n| ------- | ----------------- |\n| render  | Render once       |\n| watch   | Re-render on save |\n');
  assert.equal(alignTables('| Left | Center | Right | None |\n|:-|:-:|-:|-|\n| a | b | c | d |\n'),
    '| Left | Center | Right | None |\n| :--- | :----: | ----: | ---- |\n| a    |   b    |     c | d    |\n');
  assert.equal(alignTables('a | bb\n-|-\nccc | d\n'), '| a   | bb  |\n| --- | --- |\n| ccc | d   |\n');
  assert.equal(alignTables('| a | b |\n|-|-|\n| x \\| y | z |\n'), '| a      | b   |\n| ------ | --- |\n| x \\| y | z   |\n');
  assert.equal(alignTables('| a | b |\n|-|-|\n| c |\n'), '| a   | b   |\n| --- | --- |\n| c   |     |\n');
  assert.equal(alignTables('- Item\n\n  | a | bb |\n  |-|-|\n  | c | d |\n'), '- Item\n\n  | a   | bb  |\n  | --- | --- |\n  | c   | d   |\n');
  assert.equal(alignTables('| a |\n|-|\n| b |'), '| a   |\n| --- |\n| b   |\n');

  for (const unchanged of ['| a | b |\n|-|-|\n| c | d | e |\n', '```\n| a | b |\n|-|-|\n| ccc | d |\n```\n', 'Use a | b in text.\n\n| not | a table |\n']) {
    assert.equal(alignTables(unchanged), unchanged);
  }
});

test('counts wide characters and emoji as two columns, and combining marks as none, like Raindown', () => {
  const { alignTables } = RaindownPlugin;

  assert.equal(alignTables('| a | b |\n|-|-|\n| 日本語 | 🎉 |\n| 👨‍👩‍👧 | 🇯🇵 |\n'),
    '| a      | b   |\n| ------ | --- |\n| 日本語 | 🎉  |\n| 👨‍👩‍👧     | 🇯🇵  |\n');
  assert.equal(alignTables('| a | b |\n|-|-|\n| cafés | ❤️ |\n| 한 | ❤ |\n'),
    '| a     | b   |\n| ----- | --- |\n| cafés | ❤️  |\n| 한    | ❤   |\n');
  assert.equal(alignTables('| left | center | right |\n|:-|:-:|-:|\n| 日 | 日 | 日 |\n'),
    '| left | center | right |\n| :--- | :----: | ----: |\n| 日   |   日   |    日 |\n');
});

test('lines up a table as a key is typed in it, keeping the cursor after what was typed', () => {
  const text = '| a   | b   |\n| --- | --- |\n| cccc | d   |\n';
  const head = text.indexOf('cccc') + 4;
  const { changes, selection } = RaindownPlugin.tableAlignmentChanges(text, { anchor: head, head });
  const aligned = changes.reduce((note, { from, to, insert }) => note.slice(0, from) + insert + note.slice(to), text);

  assert.equal(aligned, '| a    | b   |\n| ---- | --- |\n| cccc | d   |\n');
  assert.deepEqual(selection, { anchor: aligned.indexOf('cccc') + 4, head: aligned.indexOf('cccc') + 4 });
  assert.equal(RaindownPlugin.tableAlignmentChanges(aligned, { anchor: 0, head: 0 }), null);
});

test('lines up tables in the same change as what was typed, and not for other changes, or with write-back off', () => {
  const text = '| a | b |\n|-|-|\n';
  // A change deleting the before text's 'deleted', or else typing.
  const transaction = (userEvent, deleted = 'x') => ({
    docChanged: true,
    isUserEvent: (event) => userEvent === event || userEvent.startsWith(`${event}.`),
    newSelection: { main: { anchor: 3, head: 3 } },
    newDoc: { toString: () => text, lineAt: () => ({ text: '| a | b |' }) },
    startState: { sliceDoc: () => deleted },
    changes: { iterChanges: (each) => each(0, deleted.length, 0, 0, { length: userEvent.startsWith('delete') ? 0 : 1 }) }
  });
  const settings = { writeBack: true };
  const tableAlignment = RaindownPlugin.tableAlignment({ settings });

  for (const userEvent of ['input.type', 'delete.backward']) {
    const typed = transaction(userEvent);
    const [first, alignment] = tableAlignment(typed);
    assert.equal(first, typed);
    assert.equal(alignment.sequential, true);
    assert.equal(alignment.changes.length, 2);
  }

  // Deleting a formula cell's padding shows its formula, so it's left for Raindown to see.
  for (const other of [transaction('undo'), transaction('input.type.compose'), transaction('delete.backward', '  ')]) {
    assert.equal(tableAlignment(other), other);
  }
  settings.writeBack = false;
  const typed = transaction('input.type');
  assert.equal(tableAlignment(typed), typed);
});

test('keeps a column with equals signs as wide as they are, and lines up + rows, keeping their +', () => {
  assert.equal(RaindownPlugin.alignTables('| name | notes |\n|-|:======|\n| Ada | Tag the |\n|+| build |\n| Lin | far too long |\n'),
    '| name | notes   |\n| ---- | :====== |\n| Ada  | Tag the |\n|+     | build   |\n| Lin  | far too long |\n');
});

test('carries a cell on onto a + row on Option or Alt and Enter, with what is after the cursor, but not in the header', () => {
  const note = '| task | notes |\n| --- | ===== |\n| Release | Tag the build |\n';
  const at = note.indexOf('the build') + 3;
  const change = RaindownPlugin.carriedOnCell(note, at);
  const changed = note.slice(0, change.from) + change.insert + note.slice(change.to);

  assert.equal(changed, '| task | notes |\n| --- | ===== |\n| Release | Tag the |\n|+ | build |\n');
  assert.equal(changed.slice(change.cursor), 'build |\n');
  assert.notEqual(RaindownPlugin.carriedOnCell(note, note.indexOf('Release') + 2), null);
  assert.equal(RaindownPlugin.carriedOnCell(note, note.indexOf('notes')), null);
});

// What Enter makes of the note, and the text after the cursor on its line.
function entered(note, at, options = { bare: true }) {
  const change = RaindownPlugin.enteredCell(note, at, options);
  const changed = note.slice(0, change.from) + change.insert + note.slice(change.to);
  return { changed, after: changed.slice(change.cursor).split('\n')[0], toggle: change.toggle };
}

test('moves to the end of the same cell in the row below on Enter, like a spreadsheet, adding one below the last row', () => {
  const note = '| task | notes |\n| --- | ===== |\n| Release | Tag |\n|+ | the build |\n| Docs | Done |\n';

  assert.deepEqual(entered(note, note.indexOf('Tag') + 1), { changed: note, after: ' |', toggle: null });
  assert.equal(entered(note, note.indexOf('task') + 1).after, ' | Tag |');
  const added = entered(note, note.indexOf('Done'));
  assert.equal(added.changed, `${note}|  |  |\n`);
  assert.equal(added.after, ' |');
  assert.equal(RaindownPlugin.enteredCell('Not a table\n', 2, {}), null);
});

test("collapses a table: block's expanded cell on Enter, joining its + rows back into its row", () => {
  const note = "table: 'tasks.csv'\n<!-- 2 rows · 1a2b3c -->\n| task | notes |\n| --- | ===== |\n| Release | Tag the |\n|+ | build |\n| Docs | Done |\n";

  assert.deepEqual(entered(note, note.indexOf('build')), {
    changed: note.replace('| Release | Tag the |\n|+ | build |', '| Release | Tag the build |'), after: ' |', toggle: 'collapse'
  });
  assert.equal(RaindownPlugin.cellToggleAt(note, note.indexOf('build'), { bare: true }), 'collapse');
  assert.equal(RaindownPlugin.cellToggleAt(note, note.indexOf('Done'), { bare: true }), null);
});

test("expands a table: block's cell cut to fit on Enter, deleting its ellipsis, and stays in it", () => {
  const note = "table: 'tasks.csv'\n<!-- 2 rows · 1a2b3c -->\n| task | notes |\n| --- | ===== |\n| Release | Tag… |\n| Docs | Done |\n";

  assert.equal(RaindownPlugin.cellToggleAt(note, note.indexOf('Tag'), { bare: true }), 'expand');
  assert.deepEqual(entered(note, note.indexOf('Tag')), { changed: note.replace('Tag…', 'Tag'), after: ' |', toggle: 'expand' });
  assert.equal(RaindownPlugin.cellToggleAt(note.replace("table: 'tasks.csv'\n", ''), note.indexOf('Tag') - 19, { bare: true }), null);
});

test("keeps the cursor in its cell when another cell in the row is clipped", () => {
  const before = '| Milk made with beautiful cows | 54   |';
  const after = '| Milk made with bea… | 54   |';

  assert.deepEqual(RaindownPlugin.movedCursor({ line: 0, ch: before.indexOf('54') + 2 }, before, after), { line: 0, ch: after.indexOf('54') + 2 });
});

test('keeps the cursor after the last letter of a cell clipped as it was typed into, not its padding', () => {
  const before = '| Milk made with beautiful cows | 54   |';
  const after = '| Milk made with be… | 54   |';

  assert.deepEqual(RaindownPlugin.movedCursor({ line: 0, ch: before.indexOf('cows') + 4 }, before, after), { line: 0, ch: after.indexOf('…') + 1 });
});

test("knows when the cursor's in a table: block's fixed column, where typing isn't written back", () => {
  const note = "table: 'tasks.csv'\n<!-- 2 rows · 1a2b3c -->\n| task | notes |\n| --- | ===== |\n| Release | Tag the |\n|+ | build |\n| Docs | Done |\n";
  const at = (line, ch, text = note) => RaindownPlugin.inFixedCell(text, { line, ch }, { bare: true });

  assert.deepEqual([at(4, 13), at(5, 5), at(6, 10), at(2, 10)], [true, true, true, true]);
  assert.deepEqual([at(6, 3), at(2, 3), at(6, 10, note.replace("table: 'tasks.csv'\n", 'Plain\n'))], [false, false, false]);
});

test('makes a column fixed at its width when an equals sign is typed into its delimiter, and widen when a dash is', () => {
  assert.equal(RaindownPlugin.alignTables('| a | notes |\n|-|:=----|\n| x | ok |\n').split('\n')[1], '| --- | :==== |');
  assert.equal(RaindownPlugin.alignTables('| a | notes |\n|-|:==-==|\n| x | a longer note |\n').split('\n')[1], '| --- | :------------ |');
});

test("takes any comment on its own line for a node's comment, but not a directive's tags", () => {
  const before = '<!-- toc: -->\n<!-- 1 row · aaa111 -->\n<!-- :toc -->\n<!-- conflict · aaa111 -->';
  const after = '<!-- toc: -->\n<!-- 2 rows · bbb222 -->\n<!-- :toc -->\n<!-- 2 rows · bbb222 -->';

  assert.deepEqual(RaindownPlugin.blockCommentChanges(before, after).map(({ from }) => from.line), [3, 1]);
});

test('moves to the next cell on Tab, and back on Shift and Tab, across rows, staying put at either end', () => {
  const note = '| task | notes |\n| --- | ----- |\n| Release | Tag |\n|+ | the build |\n| Docs | Done |\n';
  // The text after the cursor on its line once Tab's moved it.
  const tab = (from, options) => note.slice(RaindownPlugin.tabbedCell(note, note.indexOf(from), options)).split('\n')[0];

  assert.equal(tab('task'), ' |');
  assert.equal(tab('notes'), ' | Tag |');
  assert.equal(tab('Tag'), ' | Done |');
  assert.equal(tab('Tag', { back: true }), ' | Tag |');
  assert.equal(tab('the build'), ' | Done |');
  assert.equal(tab('Docs', { back: true }), ' |');
  assert.equal(note.slice(0, RaindownPlugin.tabbedCell(note, note.indexOf('Release'), { back: true })).split('\n').at(-1), '| task | notes');
  assert.equal(tab('Done'), ' |');
  assert.equal(tab('task', { back: true }), ' | notes |');
  assert.equal(RaindownPlugin.tabbedCell('Not a table\n', 2), null);
});

test("collapses a table: block's expanded cell in its last row on Enter, then adds a row below it", () => {
  const note = "table: 'tasks.csv'\n<!-- 1 row · 1a2b3c -->\n| task | notes |\n| --- | ===== |\n| Release | Tag the |\n|+ | build |\n";

  assert.equal(entered(note, note.indexOf('build')).changed, note.replace('| Release | Tag the |\n|+ | build |\n', '| Release | Tag the build |\n|  |  |\n'));
});

test("expands and collapses each cell of a table: block's row on its own, on Enter", () => {
  const note = "table: 'tasks.csv'\n<!-- 1 row · 1a2b3c -->\n| task | notes |\n| ==== | ===== |\n| Milk… | Tag the |\n|+ | build |\n| Docs | Done |\n";
  const both = "table: 'tasks.csv'\n<!-- 1 row · 1a2b3c -->\n| task | notes |\n| ==== | ===== |\n| Milk | Tag the |\n|+made | build |\n| Docs | Done |\n";

  assert.equal(RaindownPlugin.cellToggleAt(note, note.indexOf('Milk'), { bare: true }), 'expand');
  assert.equal(entered(note, note.indexOf('Milk')).changed, note.replace('Milk…', 'Milk'));
  assert.equal(RaindownPlugin.cellToggleAt(both, both.indexOf('Milk'), { bare: true }), 'collapse');
  assert.equal(entered(both, both.indexOf('Milk')).changed, both.replace('| Milk | Tag the |\n|+made | build |', '| Milk made | Tag the |\n|+ | build |'));
  assert.equal(entered(both, both.indexOf('build')).changed, both.replace('| Milk | Tag the |\n|+made | build |', '| Milk | Tag the build |\n|+made |  |'));
});

test("deletes a table row's |+ lines with it when its line's deleted, and nothing else", () => {
  const note = '| task | notes |\n| --- | ===== |\n| Milk | Tag the |\n|+made | build |\n|+with | it |\n| Docs | Done |\n';
  const row = note.indexOf('| Milk');
  const line = { from: row, to: note.indexOf('|+made') };
  const removed = (deletions) => RaindownPlugin.orphanedRows(note, deletions).reduceRight((text, { from, to }) => text.slice(0, from) + text.slice(to), note);
  const deleted = (deletions) => deletions.reduceRight((text, { from, to }) => text.slice(0, from) + text.slice(to), removed(deletions));

  assert.equal(deleted([line]), '| task | notes |\n| --- | ===== |\n| Docs | Done |\n');
  assert.deepEqual(RaindownPlugin.orphanedRows(note, [{ from: note.indexOf('|+made'), to: note.indexOf('|+with') }]), []);
  assert.deepEqual(RaindownPlugin.orphanedRows(note, [{ from: row + 2, to: row + 6 }]), []);
  assert.deepEqual(RaindownPlugin.orphanedRows(note, [{ from: note.indexOf('| Docs'), to: note.length }]), []);
});

test('deletes the |+ lines in the same change as deleting their row, and leaves other changes alone', () => {
  const note = '| task | notes |\n| --- | ===== |\n| Milk | Tag the |\n|+made | build |\n';
  const from = note.indexOf('| Milk');
  const transaction = (userEvent) => ({
    docChanged: true,
    isUserEvent: (event) => userEvent === event || userEvent.startsWith(`${event}.`),
    startState: { doc: { toString: () => note } },
    changes: { iterChanges: (each) => each(from, note.indexOf('|+made'), from, from, '') }
  });

  const deleted = transaction('delete.line');
  assert.deepEqual(RaindownPlugin.rowDeletions()(deleted), [deleted, { changes: [{ from: note.indexOf('|+made'), to: note.length }] }]);
  const typed = transaction('input.type');
  assert.equal(RaindownPlugin.rowDeletions()(typed), typed);
});

test('moves down from the delimiter row on Enter and Tab, like from any row, rather than splitting the table', () => {
  const note = '| task | notes |\n| ---- | ===== |\n| Milk | Tag |\n';
  const at = note.indexOf('=====') + 2;

  assert.equal(entered(note, at).after, ' |');
  assert.equal(note.slice(0, RaindownPlugin.enteredCell(note, at, {}).cursor).split('\n').at(-1), '| Milk | Tag');
  assert.equal(entered('| task | notes |\n| ---- | ===== |\n', at).changed, '| task | notes |\n| ---- | ===== |\n|  |  |\n');
  assert.equal(note.slice(0, RaindownPlugin.tabbedCell(note, note.indexOf('----'))).split('\n').at(-1), '| ---- | =====');
  assert.equal(RaindownPlugin.carriedOnCell(note, at), null);
  assert.equal(RaindownPlugin.inFixedCell(`table: 'tasks.csv'\n${note}`, { line: 2, ch: 10 }, { bare: true }), false);
});

test("sends an endpoint's or a node's request from Raindown with Obsidian's requestUrl, and refuses link-local hosts", async () => {
  const { vault } = fakeVault({ 'note.md': '# A' });
  const Worker = fakeWorker(() => ({ ready: true }));
  const sent = [];
  const requestUrl = async (request) => {
    sent.push(request);
    return { status: 201, text: '{"id":1}', headers: { 'Content-Type': 'application/json' } };
  };
  const engine = new RaindownEngine({ vault }, { runtime: fakeRuntime, Worker, requestUrl });
  await engine.start();

  await engine.receive({ id: 1, type: 'fetch', request: { method: 'POST', url: 'https://a.io/x', headers: { A: 'b' }, body: 'c' } });
  await engine.receive({ id: 2, type: 'fetch', request: { method: 'GET', url: 'http://2852039166/latest', headers: {}, body: null } });
  assert.deepEqual(sent, [{ url: 'https://a.io/x', method: 'POST', headers: { A: 'b' }, body: 'c', throw: false }]);
  const [first, second] = Worker.made[0].sent.slice(1);
  assert.deepEqual([first.type, first.id, { ...first.response, milliseconds: 0 }], [
    'fetched', 1, { body: '{"id":1}', status: 201, headers: { 'Content-Type': 'application/json' }, content_type: 'application/json', milliseconds: 0 }
  ]);
  assert.match(second.response.error, /link-local addresses, like cloud metadata at 169\.254\.169\.254$/);
});

test('runs the endpoints in the active note from its command', async () => {
  const { raindown, engine, file } = await plugin({ content: '<!-- endpoint: -->\n' });
  raindown.app.workspace.getActiveFile = () => file;

  raindown.commands.find(({ id }) => id === 'run-endpoints').checkCallback(false);
  await new Promise((done) => { setTimeout(done, 10); });
  assert.deepEqual(engine.asked, [{ path: 'note.md', markdown: '<!-- endpoint: -->\n', bare: false, execute: true }]);
});

test('shows a section with <{ }> in reading view as Raindown renders it, in Markdown, which Obsidian renders', async () => {
  const text = '# A\n\n<{ :toc }>\n\nText\n';
  const { raindown } = await plugin();
  const asked = [];
  raindown.engine = {
    ...fakeEngine(),
    render: async (note) => {
      asked.push(note);
      return { output: note.markdown.replace('<{ :toc }>', '- [A](#a)') };
    }
  };
  raindown.app.vault.getAbstractFileByPath = (path) => ({ path });
  const el = { children: ['as Obsidian rendered it'], replaceChildren(...children) { this.children = children; } };
  const context = (line) => ({ sourcePath: 'note.md', getSectionInfo: () => ({ text, lineStart: line, lineEnd: line }) });

  await raindown.renderSection(el, context(2));
  await raindown.renderSection(el, context(2));
  assert.deepEqual(el.children, ['\n\n- [A](#a)\n\n']);
  assert.deepEqual(asked.map(({ path, bare }) => [path, bare]), [['note.md', false]]);

  await raindown.renderSection(el, context(4));
  assert.equal(asked.length, 1);
});

test("renders all of a note's sections with <{ }> in reading view at once, as Obsidian read its sections", async () => {
  const text = '# A\n\n<{ :toc }>\n\nText\n\n<{ title }>\n';
  const { raindown } = await plugin();
  const asked = [];
  raindown.engine = {
    ...fakeEngine(),
    render: async (note) => {
      asked.push(note.markdown);
      return { output: note.markdown.replace('<{ :toc }>', '- [A](#a)').replace('<{ title }>', 'A') };
    }
  };
  raindown.app.vault.getAbstractFileByPath = (path) => ({ path });
  const lines = [[0, 0], [2, 2], [4, 4], [6, 6]];
  raindown.app.metadataCache = {
    getFileCache: () => ({ sections: lines.map(([start, end]) => ({ position: { start: { line: start }, end: { line: end } } })) })
  };
  const rendered = (line) => {
    const el = { children: [], replaceChildren(...children) { this.children = children; } };
    return raindown.renderSection(el, { sourcePath: 'note.md', getSectionInfo: () => ({ text, lineStart: line, lineEnd: line }) })
      .then(() => el.children);
  };

  assert.deepEqual(await Promise.all([rendered(2), rendered(6)]), [['\n\n- [A](#a)\n\n'], ['\n\nA\n\n']]);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /raindown:section 0 -->\n\n<\{ :toc \}>[\s\S]*raindown:section 1 -->\n\n<\{ title \}>/);
});
