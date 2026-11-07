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
console.log(JSON.stringify({ ready: true, version: '0.11.0' }));
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
function fakeEditor(text) {
  return {
    text,
    getValue() { return this.text; },
    offsetToPos(offset) { return offset; },
    cursor: { line: 0, ch: 0 },
    getCursor() { return this.cursor; },
    setSelection(_anchor, head) { this.cursor = head; },
    replaceRange(replacement, from, to) { this.text = this.text.slice(0, from) + replacement + this.text.slice(to); },
    transaction({ changes }) {
      const lines = this.text.split('\n');
      for (const { from, to, text: replacement } of changes) {
        lines[from.line] = lines[from.line].slice(0, from.ch) + replacement + lines[from.line].slice(to.ch);
      }
      this.text = lines.join('\n');
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
  assert.ok(RaindownPlugin.hasDirectives('# A\n\ntoc:\n', { bare: true }));
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
  assert.equal(raindown.status.text, 'Raindown: raindown: note.md: Missing end tag');

  await raindown.writeBack(file, { notify: true });
  assert.equal(Notice.messages.at(-1), 'raindown: note.md: Missing end tag');

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
