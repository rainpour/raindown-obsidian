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

  return resolve.call(this, request, ...rest);
};

const RaindownPlugin = require('../main');
const { FileSystemAdapter, Notice } = require('./obsidian');

// A stand-in for raindown that prints its arguments and what it was given, with a table of contents filled in.
function fakeRaindown(dir, script) {
  const file = path.join(dir, 'raindown');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return file;
}

const FILL_TOC = `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => process.stdout.write(input.replace('<!-- :toc -->', '- [A](#a)\\n<!-- :toc -->')));`;

async function plugin({ dir, content, command, typed }) {
  let current = content;
  const app = {
    vault: {
      adapter: new FileSystemAdapter(dir),
      read: async () => current,
      process: async (_file, change) => { current = change(typed ?? current); },
      on: () => {}
    },
    workspace: {}
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
});

test('passes the note to Raindown to rewrite, and -x to run its endpoints', () => {
  assert.deepEqual(RaindownPlugin.rewriteArgs('/v/note.md'), ['/v/note.md', '--stdin', '--rewrite']);
  assert.deepEqual(RaindownPlugin.rewriteArgs('/v/note.md', { execute: true }), ['/v/note.md', '--stdin', '--rewrite', '-x']);
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

  raindown.settings.command = fakeRaindown(dir, '');
  await raindown.writeBack(file, { notify: true });
  assert.equal(Notice.messages.at(-1), "Raindown didn't print the note back, so it's left as it is");

  raindown.settings.command = '/nowhere/raindown';
  await raindown.writeBack(file, { notify: true });
  assert.match(Notice.messages.at(-1), /^Couldn't run "\/nowhere\/raindown"/);
});
