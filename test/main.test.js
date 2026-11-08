'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// The plugin requires 'obsidian', which only Obsidian provides, so it's given the stub instead.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return path.join(__dirname, 'obsidian.js');
  if (request.startsWith('@codemirror/')) return path.join(__dirname, 'codemirror.js');

  return resolve.call(this, request, ...rest);
};

// A home and a shell of its own, so Raindown already on this computer isn't found.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-home-'));
process.env.SHELL = fakeShell('');

const RaindownPlugin = require('../main');
const { FileSystemAdapter, Modal, Notice } = require('./obsidian');

// A stand-in for raindown that runs the script, and has no server, like a Raindown from before it.
function fakeRaindown(dir, script) {
  const file = path.join(dir, 'raindown');
  fs.writeFileSync(file, `#!/usr/bin/env node\nif (process.argv[2] === 'server') process.exit(1);\n${script}\n`, { mode: 0o755 });
  return file;
}

// A stand-in for "raindown server", filling in tables of contents and rendering sections, which logs each request.
function fakeServer(dir) {
  const log = path.join(dir, 'requests.log');
  const file = path.join(dir, 'raindown-server');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
console.log(JSON.stringify({ ready: true, version: '0.17.0' }));
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end !== -1; end = buffer.indexOf('\\n')) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    fs.appendFileSync(${JSON.stringify(log)}, (request.rewrite ? 'rewrite' : 'render') + '\\n');
    const output = request.rewrite
      ? request.markdown.replace('<!-- :toc -->', '- [A](#a)\\n<!-- :toc -->')
      : '<h1>A</h1><!-- raindown:section --><ul></ul><!-- raindown:end-section -->';
    console.log(JSON.stringify({ id: request.id, output, warnings: [] }));
  }
});
`, { mode: 0o755 });
  return { command: file, requests: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

// A stand-in for a login shell, whose setup prints first, then prints where raindown is.
function fakeShell(found) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-shell-')), 'zsh');
  fs.writeFileSync(file, `#!/bin/sh\necho 'Welcome back'\necho '${found}'\n`, { mode: 0o755 });
  return file;
}

const FILL_TOC = `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => process.stdout.write(input.replace('<!-- :toc -->', '- [A](#a)\\n<!-- :toc -->')));`;

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

async function plugin({ dir, content, command, typed, editor }) {
  let current = content;
  const app = {
    vault: {
      adapter: new FileSystemAdapter(dir),
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
  raindown.settings.command = command;

  return { raindown, file: { path: 'note.md', extension: 'md' }, current: () => current };
}

test('only applies what Raindown wrote back to the note it was given', () => {
  assert.equal(RaindownPlugin.applyRewrite('a', 'a', 'b'), 'b');
  assert.equal(RaindownPlugin.applyRewrite('a and more', 'a', 'b'), 'a and more');
});

test('only starts Raindown for notes with directives', () => {
  assert.ok(RaindownPlugin.hasDirectives('# A\n\n<!-- toc: -->\n'));
  assert.ok(RaindownPlugin.hasDirectives('---\nraindown: true\n---\n'));
  assert.ok(!RaindownPlugin.hasDirectives('# A\n\n<!-- a note -->\nJust text.\n'));
  assert.ok(!RaindownPlugin.hasDirectives('# A\n\ntoc:\n'));
  assert.ok(RaindownPlugin.hasDirectives('# A\n\ntoc:\n', { bareSyntax: true }));
});

test('passes the note to Raindown to rewrite, and -x to run its endpoints', () => {
  assert.deepEqual(RaindownPlugin.rewriteArgs('/v/note.md'), ['/v/note.md', '--stdin', '--rewrite']);
  assert.deepEqual(RaindownPlugin.rewriteArgs('/v/note.md', { execute: true }), ['/v/note.md', '--stdin', '--rewrite', '-x']);
  assert.deepEqual(RaindownPlugin.rewriteArgs('/v/note.md', { bare: true }), ['/v/note.md', '--stdin', '--rewrite', '--bare']);
  assert.equal(RaindownPlugin.expandCommand('~/bin/raindown'), path.join(os.homedir(), 'bin/raindown'));
});

test('writes back to the note, and not again for the save that makes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const content = '# A\n\n<!-- toc: -->\n<!-- :toc -->\n';
  const { raindown, file, current } = await plugin({ dir, content, command: fakeRaindown(dir, FILL_TOC) });

  await raindown.writeBack(file);
  assert.equal(current(), '# A\n\n<!-- toc: -->\n- [A](#a)\n<!-- :toc -->\n');

  raindown.settings.command = '/nowhere/raindown';
  await raindown.writeBack(file);
  assert.equal(raindown.status.text, '');
});

test('keeps what was typed while Raindown ran', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const typed = '# A\n\n<!-- toc: -->\n<!-- :toc -->\n\nMore\n';
  const { raindown, file, current } = await plugin({ dir, content: '# A\n\n<!-- toc: -->\n<!-- :toc -->\n', typed, command: fakeRaindown(dir, FILL_TOC) });

  await raindown.writeBack(file);
  assert.equal(current(), typed);
});

test("shows Raindown's errors in the status bar, and in a notice from a command", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const command = fakeRaindown(dir, "process.stderr.write('raindown: note.md: Missing end tag\\n'); process.exit(1);");
  const { raindown, file } = await plugin({ dir, content: '<!-- toc: -->\n', command });

  await raindown.writeBack(file);
  assert.equal(raindown.status.text, 'Raindown: note.md: Missing end tag');

  await raindown.writeBack(file, { notify: true });
  assert.equal(Notice.messages.at(-1), 'note.md: Missing end tag');

  raindown.settings.command = fakeRaindown(dir, "process.stderr.write('Unknown arguments: note.md --stdin --rewrite\\n'); process.exit(1);");
  await raindown.writeBack(file, { notify: true });
  assert.match(Notice.messages.at(-1), /^This Raindown is too old/);

  raindown.settings.command = fakeRaindown(dir, '');
  await raindown.writeBack(file, { notify: true });
  assert.equal(Notice.messages.at(-1), "Raindown didn't print the note back, so it's left as it is");

  raindown.settings.command = '/nowhere/raindown';
  await raindown.writeBack(file, { notify: true });
  assert.match(Notice.messages.at(-1), /^Couldn't run "\/nowhere\/raindown"/);
});

test("shows how to install Raindown once, when it can't be found", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown, file } = await plugin({ dir, content: '<!-- toc: -->\n', command: '/nowhere/raindown' });

  const opened = Modal.opened.length;
  await raindown.writeBack(file, { notify: true });
  await raindown.writeBack(file, { notify: true });
  assert.equal(Modal.opened.length - opened, 1);
});

test('finds Raindown once it has been installed, and starts a new server for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown, file } = await plugin({ dir, content: '<!-- toc: -->\n', command: '/nowhere/raindown' });
  await raindown.writeBack(file, { notify: true });
  const { check } = Modal.opened.at(-1);
  const stale = raindown.server;

  assert.equal(await check(), false);
  const found = fakeRaindown(dir, FILL_TOC);
  process.env.SHELL = fakeShell(found);
  assert.equal(await check(), true);
  process.env.SHELL = fakeShell('');

  assert.equal(raindown.settings.command, found);
  assert.notEqual(raindown.server, stale);
});

test("uses Raindown from the shell's PATH when Obsidian can't find it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const found = fakeRaindown(dir, FILL_TOC);
  const { raindown, file, current } = await plugin({ dir, content: '# A\n\n<!-- toc: -->\n<!-- :toc -->\n', command: 'raindown-nowhere' });

  process.env.SHELL = fakeShell(found);
  await raindown.writeBack(file);
  process.env.SHELL = fakeShell('');

  assert.equal(raindown.settings.command, found);
  assert.equal(current(), '# A\n\n<!-- toc: -->\n- [A](#a)\n<!-- :toc -->\n');
  assert.equal(raindown.status.text, '');
});

test("doesn't use a Raindown from the shell's PATH that doesn't run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown, file } = await plugin({ dir, content: '<!-- toc: -->\n', command: 'raindown-nowhere' });

  process.env.SHELL = fakeShell(fakeRaindown(dir, 'process.exit(1);'));
  await raindown.writeBack(file);
  process.env.SHELL = fakeShell('');

  assert.equal(raindown.settings.command, 'raindown-nowhere');
});

test('changes an open note in its editor, with unsaved typing, only where it changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const editor = fakeEditor('# A\n\n<!-- toc: -->\n<!-- :toc -->\n\nTyped, not saved\n');
  const { raindown, file, current } = await plugin({ dir, content: '# A\n', command: fakeRaindown(dir, FILL_TOC), editor });

  await raindown.writeBack(file);
  assert.equal(editor.text, '# A\n\n<!-- toc: -->\n- [A](#a)\n<!-- :toc -->\n\nTyped, not saved\n');
  assert.equal(current(), '# A\n');

  assert.deepEqual(RaindownPlugin.changedRange('abc', 'aXc'), { from: 1, to: 2, text: 'X' });
  assert.deepEqual(RaindownPlugin.changedRange('aa', 'aaa'), { from: 2, to: 2, text: 'a' });
});

test('compares versions', () => {
  assert.ok(RaindownPlugin.isOlder('0.11.0', '0.15.0'));
  assert.ok(RaindownPlugin.isOlder('0.9.9\n', '0.15.0'));
  assert.ok(!RaindownPlugin.isOlder('0.15.0', '0.15.0'));
  assert.ok(!RaindownPlugin.isOlder('1.0', '0.15.0'));
  assert.ok(!RaindownPlugin.isOlder('0.17.0', '0.15.0'));
});

test('shows how to update an old Raindown, once until another is found', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown } = await plugin({ dir, content: '', command: 'raindown' });
  const opened = Modal.opened.length;

  raindown.checkVersion('0.17.0');
  raindown.checkVersion('0.11.0');
  raindown.checkVersion('0.11.0');
  assert.equal(Modal.opened.length - opened, 1);
  assert.equal(Modal.opened.at(-1).wording().title, 'Update Raindown');

  await raindown.useRaindown('raindown');
  raindown.checkVersion('0.11.0');
  assert.equal(Modal.opened.length - opened, 2);
});

test('offers the install command for the computer', () => {
  assert.equal(RaindownPlugin.installCommand('darwin'), 'curl -fsSL https://raindown.dev/install.sh | sh');
  assert.equal(RaindownPlugin.installCommand('linux'), 'curl -fsSL https://raindown.dev/install.sh | sh');
  assert.equal(RaindownPlugin.installCommand('win32'), 'irm https://raindown.dev/install.ps1 | iex');
});

test('looks for the standalone binary where it is usually installed', () => {
  assert.equal(RaindownPlugin.binaryPath('darwin'), path.join(process.env.HOME, '.local', 'bin', 'raindown'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const notes = { 'a.md': '# A\n\n<!-- toc: -->\n<!-- :toc -->\n', 'b.md': '# B\n', 'c.md': '# C\n\n<!-- list: -->\n' };
  const { raindown } = await plugin({ dir, content: '', command: fakeRaindown(dir, FILL_TOC) });
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

test("picks a section's HTML out of the whole note's, for reading view", () => {
  const marked = RaindownPlugin.markSection('# A\n<{ :toc }>\n## B', 1, 1);
  assert.equal(marked, '# A\n\n<!-- raindown:section -->\n\n<{ :toc }>\n\n<!-- raindown:end-section -->\n\n## B');
  assert.equal(RaindownPlugin.sectionHtml('<h1>A</h1>\n<!-- raindown:section -->\n<ul></ul>\n<!-- raindown:end-section -->\n'), '\n<ul></ul>\n');
  assert.equal(RaindownPlugin.sectionHtml('<h1>A</h1>'), null);
});

test("completes directive names, with the project's own nodes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown } = await plugin({ dir, content: '', command: 'raindown' });
  raindown.app.vault.adapter = {
    exists: async (folder) => folder === '.raindown',
    list: async () => ({ files: ['.raindown/BookCard.md', '.raindown/Changelog.rb', '.raindown/config.yml'] })
  };
  raindown.app.metadataCache = { getFileCache: () => ({ frontmatter: { raindown: true } }) };
  const suggest = new (require('../main').DirectiveSuggest)(raindown.app, raindown);
  const editor = (line) => ({ getLine: () => line });
  const note = { path: 'notes/a.md', parent: { path: 'notes' } };

  assert.deepEqual(suggest.onTrigger({ line: 0, ch: 7 }, editor('<!-- to'), note), { start: { line: 0, ch: 5 }, end: { line: 0, ch: 7 }, query: 'to' });
  assert.equal(suggest.onTrigger({ line: 0, ch: 2 }, editor('to'), note).query, 'to');
  assert.equal(suggest.onTrigger({ line: 0, ch: 9 }, editor('A note to'), note), null);
  assert.deepEqual(await suggest.getSuggestions({ query: 'c', file: note }), ['chart', 'Changelog']);
  assert.deepEqual(await suggest.getSuggestions({ query: 'B', file: note }), ['BookCard']);
  assert.deepEqual(await suggest.getSuggestions({ query: 'ta', file: note }), ['table']);
});

test('writes back through the server, and keeps each reading view section until the note changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const server = fakeServer(dir);
  const content = '# A\n\n<!-- toc: -->\n<!-- :toc -->\n';
  const { raindown, file, current } = await plugin({ dir, content, command: server.command });
  raindown.app.vault.getAbstractFileByPath = () => file;

  await raindown.writeBack(file);
  assert.equal(current(), '# A\n\n<!-- toc: -->\n- [A](#a)\n<!-- :toc -->\n');

  const shown = [];
  const section = (text) => ({ sourcePath: 'note.md', getSectionInfo: () => ({ text, lineStart: 2, lineEnd: 2 }) });
  const el = { replaceChildren: (html) => shown.push(html) };
  await raindown.renderSection(el, section('# A\n\n<{ :toc }>\n'));
  await raindown.renderSection(el, section('# A\n\n<{ :toc }>\n'));
  await raindown.renderSection(el, section('# A\n\n<{ :toc }>\n\n## B\n'));

  assert.deepEqual(shown, ['<ul></ul>', '<ul></ul>', '<ul></ul>']);
  assert.deepEqual(server.requests(), ['rewrite', 'render', 'render']);
  raindown.onunload();
});

test("doesn't write back lists after it's unloaded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown, file } = await plugin({ dir, content: '', command: 'raindown' });
  let writtenBack = false;
  raindown.writeBackAll = async () => { writtenBack = true; };

  raindown.scheduleListsWriteBack(file);
  raindown.onunload();
  await new Promise((resolve) => { setTimeout(resolve, 1100); });

  assert.equal(writtenBack, false);
});

test('writes back a note with only bare directives when Bare syntax is on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown, file } = await plugin({ dir, content: '# A\n\ntoc:\n', command: 'raindown' });
  let asked = 0;
  raindown.raindown = async ({ markdown }) => { asked += 1; return { output: markdown, warnings: '' }; };

  await raindown.writeBack(file, { force: true });
  raindown.settings.bareSyntax = true;
  await raindown.writeBack(file, { force: true });

  assert.equal(asked, 1);
});

test('gives a new server longer for its first answer than the ones after', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-')), 'raindown-slow');
  fs.writeFileSync(file, `#!/usr/bin/env node
console.log(JSON.stringify({ ready: true }));
let first = true;
process.stdin.on('data', (chunk) => {
  const { id } = JSON.parse(chunk);
  setTimeout(() => console.log(JSON.stringify({ id, output: '' })), first ? 300 : 0);
  first = false;
});
`, { mode: 0o755 });
  const server = new RaindownPlugin.RaindownServer(file);

  assert.equal((await server.request({ path: 'note.md', markdown: '' }, { timeout: 100 })).output, '');
  assert.equal((await server.request({ path: 'note.md', markdown: '' }, { timeout: 100 })).output, '');
  server.stop();
});

test("says why Raindown's server stopped", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-')), 'raindown-crash');
  fs.writeFileSync(file, `#!/usr/bin/env node
console.log(JSON.stringify({ ready: true }));
process.stdin.on('data', () => { process.stderr.write('raindown: server: boom\\n'); process.exit(1); });
`, { mode: 0o755 });
  const server = new RaindownPlugin.RaindownServer(file);

  await assert.rejects(server.request({ path: 'note.md', markdown: '' }, { timeout: 5000 }), /^Error: Raindown stopped: raindown: server: boom$/);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown } = await plugin({ dir, content: '', command: 'raindown' });
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

test("shows Raindown's messages without the note's path, and others' from the vault", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Google Drive-'));
  const { raindown, file } = await plugin({ dir, content: '', command: 'raindown' });
  const note = path.join(dir, 'note.md');
  const message = `raindown: ${note}: <!-- toc: --> on line 3 needs <!-- :toc -->\nraindown: ${path.join(dir, 'notes', 'Bad.md')}: bad YAML`;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const editor = fakeEditor("# A\n<!-- table: 'rtest.csv' -->\n<!-- :table -->\n");
  const { raindown, file } = await plugin({ dir, content: '', command: 'raindown', editor });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const editor = fakeEditor("# A\n<!-- table: 'abc/test.csv' -->\n<!-- :table -->\n");
  const { raindown, file } = await plugin({ dir, content: '', command: 'raindown', editor });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown, file } = await plugin({ dir, content: "<!-- toc: extra -->\n<!-- :toc -->\n", command: 'raindown' });
  raindown.raindown = async ({ markdown }) => ({ output: markdown, warnings: "line 1: toc: takes no value, so it can't read \"extra\"" });

  await raindown.writeBack(file, { force: true });

  assert.equal(raindown.errors.get('note.md'), 1);
});

test('finds the start of each line of a table, and no others', () => {
  const text = 'A | B\n\n| a | b |\n| - | - |\n  | 1 | 2 |\n\nnot | a table |\n';

  assert.deepEqual(RaindownPlugin.tableLines(text).map(({ from }) => text.slice(from).split('\n')[0]), ['| a | b |', '| - | - |', '  | 1 | 2 |']);
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
  const comment = (hash) => `<!-- table 1 row · ${hash} -->`;
  const editor = fakeEditor(`${comment('aaa111')}\n| typed more |`);
  const note = { editorFor: () => editor };

  await RaindownPlugin.prototype.applyToNote.call(note, {}, `${comment('aaa111')}\n| typed |`, `${comment('bbb222')}\n| typed |`);

  assert.equal(editor.text, `${comment('bbb222')}\n| typed more |`);
  assert.deepEqual(RaindownPlugin.tableCommentChanges(comment('aaa111'), `${comment('bbb222')}\n${comment('ccc333')}`), []);
});

test('writes a note back one at a time, once more if asked to meanwhile', async () => {
  const finished = [];
  const note = {
    writing: new Map(),
    writeBackInTurn: RaindownPlugin.prototype.writeBackInTurn,
    writeBack() { return new Promise((resolve) => finished.push(resolve)); }
  };

  note.writeBackInTurn({ path: 'a.md' });
  note.writeBackInTurn({ path: 'a.md' });
  note.writeBackInTurn({ path: 'a.md' });
  assert.equal(finished.length, 1);

  finished[0]();
  await new Promise(setImmediate);
  assert.equal(finished.length, 2);

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
  const transaction = (userEvent) => ({
    docChanged: true,
    isUserEvent: (event) => userEvent === event || userEvent.startsWith(`${event}.`),
    newSelection: { main: { anchor: 3, head: 3 } },
    newDoc: { toString: () => text, lineAt: () => ({ text: '| a | b |' }) }
  });
  const settings = { writeBack: true };
  const tableAlignment = RaindownPlugin.tableAlignment({ settings });

  const typed = transaction('input.type');
  const [first, alignment] = tableAlignment(typed);
  assert.equal(first, typed);
  assert.equal(alignment.sequential, true);
  assert.equal(alignment.changes.length, 2);

  for (const userEvent of ['undo', 'input.type.compose']) {
    const other = transaction(userEvent);
    assert.equal(tableAlignment(other), other);
  }
  settings.writeBack = false;
  assert.equal(tableAlignment(typed), typed);
});
