'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

// A stand-in for raindown that prints its arguments and what it was given, with a table of contents filled in.
function fakeRaindown(dir, script) {
  const file = path.join(dir, 'raindown');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return file;
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
    replaceRange(replacement, from, to) { this.text = this.text.slice(0, from) + replacement + this.text.slice(to); }
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

test("offers to download Raindown once, when it can't be found", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const { raindown, file } = await plugin({ dir, content: '<!-- toc: -->\n', command: '/nowhere/raindown' });

  const opened = Modal.opened.length;
  await raindown.writeBack(file, { notify: true });
  await raindown.writeBack(file, { notify: true });
  assert.equal(Modal.opened.length - opened, RaindownPlugin.binaryName() ? 1 : 0);
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

test('picks the binary released for the computer', () => {
  assert.equal(RaindownPlugin.binaryName('darwin', 'arm64', false), 'raindown-macos-arm64');
  assert.equal(RaindownPlugin.binaryName('linux', 'x64', true), 'raindown-linux-musl-x86_64');
  assert.equal(RaindownPlugin.binaryName('win32', 'x64', false), 'raindown-windows-x86_64.exe');
  assert.equal(RaindownPlugin.binaryName('win32', 'arm64', false), null);
  assert.equal(RaindownPlugin.binaryPath('darwin'), path.join(process.env.HOME, '.local', 'bin', 'raindown'));
});

test('only saves a download that matches the checksum the release lists', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-')), 'bin', 'raindown');
  const binary = Buffer.from('#!/bin/sh\n');
  const sum = crypto.createHash('sha256').update(binary).digest('hex');
  const request = (sums) => async ({ url }) => {
    if (url.endsWith('/SHA256SUMS')) return { text: sums };

    return { arrayBuffer: binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.length) };
  };

  await assert.rejects(RaindownPlugin.downloadRaindown('raindown-macos-arm64', file, { request: request(`${'0'.repeat(64)}  raindown-macos-arm64\n`) }),
    /didn't match its checksum/);
  await assert.rejects(RaindownPlugin.downloadRaindown('raindown-macos-arm64', file, { request: request('') }), /doesn't list a checksum/);
  assert.ok(!fs.existsSync(file));

  await RaindownPlugin.downloadRaindown('raindown-macos-arm64', file, { request: request(`${sum}  raindown-linux-x86_64\n${sum}  raindown-macos-arm64\n`) });
  assert.deepEqual(fs.readFileSync(file), binary);
  assert.equal(fs.statSync(file).mode & 0o111, 0o111);
});

test('offers a newer release for a downloaded binary, once a day, and not again once turned down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindown-'));
  const binary = RaindownPlugin.binaryPath();
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\necho '0.10.0'\n", { mode: 0o755 });
  const { raindown } = await plugin({ dir, content: '', command: binary });
  const request = async () => ({ json: { tag_name: 'v0.11.0' } });
  const opened = Modal.opened.length;

  await raindown.checkForUpdate(request);
  assert.equal(Modal.opened.at(-1).text, 'Raindown 0.11.0 is out, and you have 0.10.0. Update it?');

  await raindown.checkForUpdate(request);
  assert.equal(Modal.opened.length - opened, 1);

  await Modal.opened.at(-1).cancel();
  raindown.settings.checkedAt = 0;
  await raindown.checkForUpdate(request);
  assert.equal(Modal.opened.length - opened, 1);
  fs.rmSync(binary);
});

test('compares release tags with versions', () => {
  assert.ok(RaindownPlugin.isNewer('v0.11.0', '0.10.0'));
  assert.ok(RaindownPlugin.isNewer('v1.0', '0.10.9'));
  assert.ok(!RaindownPlugin.isNewer('v0.10.0', '0.10.0'));
  assert.ok(!RaindownPlugin.isNewer('v0.9.9', '0.10.0'));
});

function highlighted(text, options) {
  return RaindownPlugin.directiveTokens(text, options).map(({ from, to, type }) => [text.slice(from, to), type]);
}

test('highlights directives in comments, with their end tags, and in <{ }>', () => {
  assert.deepEqual(highlighted("<!-- files: folder: 'notes' limit=3 -->\n<!-- :files -->\n"), [
    ['files:', 'name'], ['folder:', 'prop'], ["'notes'", 'string'], ['limit=', 'prop'], ['3', 'number'], [':files', 'end']
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
  const notes = { 'a.md': '# A\n\n<!-- toc: -->\n<!-- :toc -->\n', 'b.md': '# B\n', 'c.md': '# C\n\n<!-- files: -->\n' };
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
});
