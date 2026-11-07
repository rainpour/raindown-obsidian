'use strict';

// Raindown for Obsidian: as a note's saved, Raindown writes back to it, like `raindown watch`, filling in its tables of
// contents, file lists, components and charts. Obsidian loads this one file, so it has no build step.
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EditorSuggest, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, editorInfoField, requestUrl, sanitizeHTMLToDom
} = require('obsidian');

const DEFAULT_SETTINGS = { command: 'raindown', writeBack: true, bareSyntax: false };
// A note's written back this long after each key, before Obsidian's even saved it, or once a change from outside the
// editor, like a sync, has been saved for DELAY. Typing a formula in a table waits for DELAY too, as
// =sum(c) is already whole on the way to =sum(cost), with Obsidian closing its bracket.
const TYPING_DELAY = 0;
const DELAY = 1000;
const TABLE_COMMENT = /^<!-- table (?:conflict|\d+ rows?) · [0-9a-f]+ -->$/;
const TIMEOUT = 10000;
const ENDPOINT_TIMEOUT = 60000;
const MAX_BUFFER = 32 * 1024 * 1024;
const RELEASES = 'https://github.com/rainpour/raindown/releases';
const LATEST_RELEASE = 'https://api.github.com/repos/rainpour/raindown/releases/latest';
const DAY = 24 * 60 * 60 * 1000;
// Notes listing others, which a note being added, renamed or removed changes.
const LISTS = /(?:<!--\s*|<\{\s*|^ {0,3})list:/m;
// Raindown's directives, for completing their names. A project's own nodes in .raindown/ are added to them.
const BUILT_INS = ['chart', 'endpoint', 'for', 'if', 'list', 'schema', 'table', 'toc'];
// Each section of reading view with <{ }> in it is rendered with the whole note, between these, then picked out.
const SECTION_START = '<!-- raindown:section -->';
const SECTION_END = '<!-- raindown:end-section -->';
// How many sections' HTML reading view keeps.
const SECTIONS_KEPT = 50;
// A content directive in a comment, like <!-- toc: --> or <!-- Changelog: -->, or front matter allowing bare ones.
// Saves of notes without them don't start Raindown.
const DIRECTIVE = /<!--\s*[A-Za-z][\w:]*:|^raindown:\s*true\s*$/m;
// With bare directives in every note, a line starting with a name and a colon, like toc:, might be one too.
const BARE_DIRECTIVE = /^ {0,3}[A-Za-z]\w*:(?:\s|$)/m;

function hasDirectives(markdown, { bare = false } = {}) {
  return DIRECTIVE.test(markdown) || (bare && BARE_DIRECTIVE.test(markdown));
}

// "raindown NOTE --stdin --rewrite" prints the Markdown it's given as it would write it back to NOTE, without writing
// NOTE, so Obsidian applies it to the note it's editing. With -x, endpoints without a response run too.
function rewriteArgs(filePath, { execute = false, bare = false } = {}) {
  return [filePath, '--stdin', '--rewrite', ...(execute ? ['-x'] : []), ...(bare ? ['--bare'] : [])];
}

// What Raindown wrote back is only applied to the note it was given, so typing since then is never lost.
function applyRewrite(current, original, rewritten) {
  if (current !== original) return current;

  return rewritten;
}

// The part of a note that changed, as offsets in it before and the text after, so an editor only replaces that part
// and the cursor stays where it was, when it's outside that part.
function changedRange(before, after) {
  let from = 0;
  while (from < before.length && before[from] === after[from]) from++;

  let end = 0;
  while (end < before.length - from && end < after.length - from && before.at(-1 - end) === after.at(-1 - end)) end++;

  return { from, to: before.length - end, text: after.slice(from, after.length - end) };
}

// The changes to each line that changed, last first, or null when lines were added or removed. A table lined up again
// changes lines above and below the cursor, which one change across them all would replace, moving the cursor.
function changedLines(before, after) {
  const [oldLines, newLines] = [before.split('\n'), after.split('\n')];
  if (oldLines.length !== newLines.length) return null;

  return oldLines.flatMap((line, number) => {
    if (line === newLines[number]) return [];

    const { from, to, text } = changedRange(line, newLines[number]);
    return [{ from: { line: number, ch: from }, to: { line: number, ch: to }, text }];
  }).reverse();
}

// The changes to the note's table comments, last first, to those Raindown just wrote. It wrote their files too, so
// when the note's changed since, its comments must still say so, or the next write-back reads as a conflict.
function tableCommentChanges(current, markdown) {
  const comments = (text) => text.split('\n').flatMap((line, number) => (TABLE_COMMENT.test(line) ? [{ line, number }] : []));
  const [oldComments, newComments] = [comments(current), comments(markdown)];
  if (oldComments.length !== newComments.length) return [];

  return oldComments.flatMap(({ line, number }, index) => {
    if (line === newComments[index].line) return [];

    return [{ from: { line: number, ch: 0 }, to: { line: number, ch: line.length }, text: newComments[index].line }];
  }).reverse();
}

// Where the cursor belongs on its line once it's changed: after the same text, however its spaces moved, and after a
// space it just typed, as lining up a table trims that from its cell, where the next word would need it.
function movedCursor({ line, ch }, before, after) {
  const head = before.split('\n')[line].slice(0, ch);
  const text = after.split('\n')[line];
  const wanted = head.replace(/\s/g, '').length;
  let moved = 0;
  for (let seen = 0; seen < wanted && moved < text.length; moved++) {
    if (!/\s/.test(text[moved])) seen++;
  }
  if (/\s$/.test(head) && /\s/.test(text[moved] ?? '')) moved++;

  return { line, ch: moved };
}

// The command as it's set, with ~ for the home folder, which only a shell would expand.
function expandCommand(command) {
  return command.replace(/^~(?=\/|$)/, os.homedir());
}

function errorMessage(error, stderr, command) {
  if (error.code === 'ENOENT') {
    return `Couldn't run "${command}". Run "Raindown: Download Raindown", or set its full path in the plugin's ` +
      "settings, since Obsidian doesn't always see your shell's PATH.";
  }

  // Raindown before --rewrite doesn't know it.
  if (stderr.startsWith('Unknown arguments') && stderr.includes('--rewrite')) {
    return 'This Raindown is too old for the plugin. Update it, or run "Raindown: Download Raindown".';
  }

  return stderr.trim() || error.message;
}

// Resolves with the rewritten Markdown and Raindown's warnings, like failed endpoint checks.
function runRaindown(command, args, input, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    const options = { cwd, timeout, maxBuffer: MAX_BUFFER };
    const child = childProcess.execFile(expandCommand(command), args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(errorMessage(error, stderr, command)), { code: error.code }));
      else resolve({ output: stdout, warnings: stderr.trim() });
    });

    child.stdin.on('error', () => {}); // The exit callback reports why Raindown stopped reading.
    child.stdin.end(input);
  });
}

// "raindown server" keeps Raindown loaded, so writing back or rendering doesn't start Ruby again each time. It starts
// when it's first asked something, and again after it stops. A Raindown without it, from before it, or one that doesn't
// start, isn't asked again, and requests answer null, for running Raindown once each instead.
class RaindownServer {
  constructor(command) {
    this.command = command;
    this.pending = new Map();
    this.nextId = 1;
  }

  // Resolves with Raindown's answer, like { output, warnings }, or null without a server, or rejects with its error.
  async request(message, { timeout }) {
    if (!await this.start()) return null;

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop(); // Stuck, so the next request starts it again.
        reject(new Error(`Raindown didn't answer within ${timeout / 1000} seconds`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
    });
  }

  start() {
    if (this.unsupported) return Promise.resolve(false);

    this.starting ??= new Promise((ready) => {
      this.ready = false;
      const child = childProcess.spawn(expandCommand(this.command), ['server'], { stdio: 'pipe' });
      const unsupported = () => {
        this.unsupported = true;
        ready(false);
      };
      const timer = setTimeout(() => { unsupported(); child.kill(); }, TIMEOUT);
      let buffer = '';

      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
          this.receive(buffer.slice(0, end), () => { clearTimeout(timer); ready(true); });
          buffer = buffer.slice(end + 1);
        }
      });
      child.stdin.on('error', () => {}); // Its exit says why it stopped.
      child.on('error', () => { clearTimeout(timer); unsupported(); });
      child.on('exit', () => {
        clearTimeout(timer);
        if (this.child === child) Object.assign(this, { child: null, starting: null });
        this.pending.forEach(({ reject, timer: waiting }) => { clearTimeout(waiting); reject(new Error('Raindown stopped')); });
        this.pending.clear();
        if (!this.ready) unsupported(); // Stopping before it was ready means it can't serve.
      });
      this.child = child;
    });

    return this.starting;
  }

  receive(line, ready) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not an answer.
    }
    if (message.ready) {
      this.ready = true;
      return ready();
    }

    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message);
  }

  stop() {
    this.child?.kill();
  }

  // Resolves once it's stopped, as Windows can't replace a binary that's running.
  stopAndWait() {
    if (!this.child?.pid) return Promise.resolve();

    return new Promise((stopped) => {
      this.child.once('exit', stopped);
      this.child.kill();
    });
  }
}

// The standalone binary released for this computer, like raindown-macos-arm64, or null if there isn't one.
function binaryName(platform = process.platform, arch = process.arch, musl = !process.report?.getReport().header.glibcVersionRuntime) {
  const cpu = { x64: 'x86_64', arm64: 'arm64' }[arch];
  const system = { darwin: 'macos', linux: musl ? 'linux-musl' : 'linux', win32: 'windows' }[platform];
  if (!cpu || !system || (system === 'windows' && cpu !== 'x86_64')) return null;

  return `raindown-${system}-${cpu}${system === 'windows' ? '.exe' : ''}`;
}

// Where a downloaded binary goes: outside the vault, so it isn't synced, and where a shell finds it too.
function binaryPath(platform = process.platform) {
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'raindown', 'raindown.exe');

  return path.join(os.homedir(), '.local', 'bin', 'raindown');
}

// Raindown on the PATH of a login shell, which Obsidian opened from the Dock doesn't have, like a gem installed with
// mise. The shell's setup can print too, so it's the last line that's a path.
function shellRaindown(shell = process.env.SHELL) {
  if (!shell || process.platform === 'win32') return Promise.resolve(null);

  return new Promise((resolve) => {
    childProcess.execFile(shell, ['-ilc', 'command -v raindown'], { timeout: TIMEOUT }, (error, stdout) => {
      resolve(stdout.split('\n').map((line) => line.trim()).findLast((line) => path.isAbsolute(line)) || null);
    });
  });
}

// The first of the commands that runs, as a found one may not, like a gem missing one of its own gems.
async function firstRunning(commands) {
  for (const command of commands.filter(Boolean)) {
    if (await runRaindown(command, ['--version'], '', { timeout: TIMEOUT }).then(() => true, () => false)) return command;
  }

  return null;
}

// Downloads a release's binary to file, the latest one without a tag, once it matches the checksum the release lists.
// beforeReplacing runs just before it's moved into place, so nothing's using the old one by then.
async function downloadRaindown(name, file, { tag, request = requestUrl, beforeReplacing = () => {} } = {}) {
  const release = tag ? `${RELEASES}/download/${tag}` : `${RELEASES}/latest/download`;
  const sums = (await request({ url: `${release}/SHA256SUMS` })).text;
  const expected = sums.split('\n').map((line) => line.trim().split(/\s+\*?/)).find(([, listed]) => listed === name)?.[0];
  if (!expected) throw new Error(`The release doesn't list a checksum for ${name}`);

  const binary = Buffer.from((await request({ url: `${release}/${name}` })).arrayBuffer);
  if (crypto.createHash('sha256').update(binary).digest('hex') !== expected) {
    throw new Error(`${name} didn't match its checksum, so it wasn't saved`);
  }

  // Renamed into place, so the whole binary arrives at once.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.download`, binary, { mode: 0o755 });
  await beforeReplacing();
  fs.renameSync(`${file}.download`, file);
}

// Whether a release's tag, like v0.11.0, is newer than a version, like 0.10.0.
function isNewer(tag, version) {
  const [released, installed] = [tag, version].map((text) => text.replace(/^v/, '').split('.').map(Number));
  const index = released.findIndex((part, i) => part !== (installed[i] || 0));

  return index !== -1 && released[index] > (installed[index] || 0);
}

// Highlighting, like the VS Code extension's: directives in comments, like <!-- toc: --> and the end tag <!-- :toc -->,
// in <{ }>, and bare ones where they'd write back, like toc:, with the self-closing :toc. Not in code or front matter.
const NAME = String.raw`[A-Za-z][\w-]*(?:::[A-Z]\w*)*`;
const COMMENT_DIRECTIVE = new RegExp(String.raw`<!--\s*(?:(:${NAME})|(${NAME}:))(.*?)-->`, 'g');
const ANTLERS = /<\{(.*?)\}>/g;
const BARE_SELF_CLOSING = /^( {0,3})(:toc)[ \t]*$/;
const BARE_OPEN = new RegExp(String.raw`^( {0,3})(${NAME}:)(?=[ \t]*$|[ \t]+\S)`);
// Strings, {variables}, numbers, :flags, props like folder: or limit=, and words.
const ARGUMENT = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{[A-Za-z_][\w.]*\}|(?<![\w:])-?\d+(?:\.\d+)?\b|(?<![\w:]):[A-Za-z_][\w-]*|[A-Za-z_][\w-]*(?::(?![\w:])|=)|[A-Za-z_][\w.-]*/g;

// The highlighted parts of a note, in order, as { from, to, type }, where type is a class like cm-raindown-name.
function directiveTokens(text, { bare = false } = {}) {
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  const bareHere = bare || /^raindown:\s*true\s*$/m.test(front?.[1] ?? '');
  const tokens = [];
  let offset = front ? front[0].length : 0;
  let fence = null;

  for (const line of text.slice(offset).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      fence = marker;
    } else {
      tokens.push(...lineTokens(line, { bare: bareHere }).map((token) => ({ ...token, from: token.from + offset, to: token.to + offset })));
    }
    offset += line.length + 1;
  }

  return tokens.sort((a, b) => a.from - b.from);
}

function lineTokens(line, { bare }) {
  const code = [...line.matchAll(/(`+)[^`]*?\1/g)].map((match) => [match.index, match.index + match[0].length]);
  const tokens = [];
  const add = (from, to, type) => {
    if (!code.some(([start, end]) => from < end && to > start)) tokens.push({ from, to, type });
  };

  for (const match of line.matchAll(COMMENT_DIRECTIVE)) {
    const name = match[1] ?? match[2];
    const start = match.index + match[0].indexOf(name);
    add(start, start + name.length, match[1] ? 'end' : 'name');
    argumentTokens(match[3], start + name.length, { antlers: false }, add);
  }
  for (const match of line.matchAll(ANTLERS)) {
    const end = match.index + match[0].length;
    add(match.index, match.index + 2, 'delimiter');
    argumentTokens(match[1], match.index + 2, { antlers: true }, add);
    add(end - 2, end, 'delimiter');
  }
  if (!bare) return tokens;

  const selfClosing = BARE_SELF_CLOSING.exec(line);
  const open = BARE_OPEN.exec(line);
  if (selfClosing) add(selfClosing[1].length, selfClosing[1].length + selfClosing[2].length, 'self-closing');
  if (open) {
    const end = open[1].length + open[2].length;
    add(open[1].length, end, 'name');
    argumentTokens(line.slice(end), end, { antlers: false }, add);
  }

  return tokens;
}

// In <{ }>, its first word is the directive, like toc: or :toc, and words are variables. Outside, words are text.
function argumentTokens(text, offset, { antlers }, add) {
  let first = antlers;
  for (const match of text.matchAll(ARGUMENT)) {
    const type = argumentType(match[0], { antlers, first });
    first = false;
    if (type) add(offset + match.index, offset + match.index + match[0].length, type);
  }
}

function argumentType(token, { antlers, first }) {
  if (/^["']/.test(token)) return 'string';
  if (token.startsWith('{')) return 'variable';
  if (/^-?\d/.test(token)) return 'number';
  if (token.startsWith(':')) return first ? 'end' : 'flag';
  if (/[:=]$/.test(token)) return first ? 'name' : 'prop';

  return antlers ? 'variable' : null;
}

// Whether the cursor's in a table cell starting with =, so a formula that's still being typed.
function inFormulaCell(line, ch) {
  const start = line.lastIndexOf('|', ch - 1);
  if (!line.trimStart().startsWith('|') || start === -1) return false;

  return line.slice(start + 1, ch).trimStart().startsWith('=');
}

// How long to wait after a key, before writing back.
function typingDelay(editor) {
  const { line, ch } = editor.getCursor();
  if (inFormulaCell(editor.getLine(line), ch)) return DELAY;

  return TYPING_DELAY;
}

// The start of each line of a Markdown table, as Raindown's columns only line up in a monospace font.
function tableLines(markdown) {
  return [...markdown.matchAll(/^[ \t]*\|.*\|[ \t]*$/gm)].map(({ index }) => ({ from: index, type: 'table' }));
}

// The line an error is on, from Raindown's messages like "<!-- toc: --> on line 7 needs <!-- :toc -->", or null.
function errorLine(message) {
  const line = /\bon line (\d+)\b/.exec(message ?? '')?.[1];

  return line ? Number(line) : null;
}

// The editor extension, from the CodeMirror Obsidian has, highlighting a note again as it changes, and underlining
// the line of its error, if it has one, and setting its tables in a monospace font.
function highlighting(plugin) {
  const { Decoration, ViewPlugin } = require('@codemirror/view');
  const { RangeSetBuilder } = require('@codemirror/state');
  const marks = {
    error: Decoration.line({ class: 'cm-raindown-error' }),
    table: Decoration.line({ class: 'cm-raindown-table' })
  };
  const errorFor = (view) => plugin.errors.get(view.state.field(editorInfoField, false)?.file?.path) ?? null;
  const decorate = (view) => {
    const builder = new RangeSetBuilder();
    const line = errorFor(view);
    const markdown = view.state.doc.toString();
    const ranges = [...directiveTokens(markdown, { bare: plugin.settings.bareSyntax }), ...tableLines(markdown)];
    if (line && line <= view.state.doc.lines) ranges.unshift({ from: view.state.doc.line(line).from, type: 'error' });

    for (const { from, to, type } of ranges.sort((a, b) => a.from - b.from || (a.to ?? -1) - (b.to ?? -1))) {
      builder.add(from, to ?? from, marks[type] ??= Decoration.mark({ class: `cm-raindown-${type}` }));
    }
    return { decorations: builder.finish(), line };
  };

  return ViewPlugin.fromClass(class {
    constructor(view) { ({ decorations: this.decorations, line: this.line } = decorate(view)); }
    update(update) {
      if (update.docChanged || this.line !== errorFor(update.view)) {
        ({ decorations: this.decorations, line: this.line } = decorate(update.view));
      }
    }
  }, { decorations: (instance) => instance.decorations });
}

// The HTML Raindown rendered between a section's markers, from the whole note's.
function sectionHtml(html) {
  const start = html.indexOf(SECTION_START);
  const end = html.indexOf(SECTION_END);
  if (start === -1 || end === -1) return null;

  return html.slice(start + SECTION_START.length, end);
}

// The note with a section's lines between markers, each a block of its own, so Raindown keeps them in its HTML.
function markSection(text, lineStart, lineEnd) {
  const lines = text.split('\n');
  lines.splice(lineEnd + 1, 0, '', SECTION_END, '');
  lines.splice(lineStart, 0, '', SECTION_START, '');

  return lines.join('\n');
}

// Completes a directive's name, after <!-- or <{, or at the start of a line where bare directives write back, from
// Raindown's own and the project's nodes in its .raindown folder.
class DirectiveSuggest extends EditorSuggest {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const bare = this.plugin.settings.bareSyntax || this.app.metadataCache.getFileCache(file)?.frontmatter?.raindown === true;
    const match = /(?:<!--\s*|<\{\s*)([A-Za-z][\w-]*)$/.exec(before) || (bare && /^ {0,3}([A-Za-z][\w-]*)$/.exec(before));
    if (!match) return null;

    return { start: { line: cursor.line, ch: cursor.ch - match[1].length }, end: cursor, query: match[1] };
  }

  async getSuggestions(context) {
    const names = [...BUILT_INS, ...await this.plugin.projectNodes(context.file)];
    const query = context.query.toLowerCase();

    return names.filter((name) => name.toLowerCase().startsWith(query));
  }

  renderSuggestion(name, el) {
    el.setText(`${name}:`);
  }

  selectSuggestion(name) {
    const { editor, start, end } = this.context;
    editor.replaceRange(`${name}: `, start, end);
  }
}

class RaindownPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.timers = new Map();
    // Each note being written back, and whether it's been asked to again.
    this.writing = new Map();
    // What each note was last written back as, so the save that writing it back makes doesn't start Raindown again.
    this.written = new Map();
    // Each section's HTML in reading view, by its note's path and Markdown.
    this.sections = new Map();
    this.status = this.addStatusBarItem();
    this.addSettingTab(new RaindownSettingTab(this.app, this));

    this.addCommand({
      id: 'write-back',
      name: 'Write back this note',
      checkCallback: (checking) => this.withActiveNote(checking, (file) => this.writeBack(file, { notify: true }))
    });
    this.addCommand({
      id: 'run-endpoints',
      name: 'Run the endpoints in this note',
      checkCallback: (checking) => this.withActiveNote(checking, (file) => this.writeBack(file, { execute: true, notify: true }))
    });
    this.addCommand({
      id: 'write-back-all', name: 'Write back all notes', callback: () => this.writeBackAll(hasDirectives, { notify: true })
    });
    this.addCommand({ id: 'download', name: 'Download Raindown', callback: () => this.installRaindown() });
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      if (info.file) this.scheduleWriteBack(info.file, typingDelay(editor));
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => this.scheduleWriteBack(file)));
    // The line of each note's error, for the editor to underline.
    this.errors = new Map();
    this.registerEditorExtension(highlighting(this));
    this.registerEditorSuggest(new DirectiveSuggest(this.app, this));
    this.registerMarkdownPostProcessor((el, context) => this.renderSection(el, context));
    // Obsidian adds every file as it loads, so lists are only written back for notes added after that.
    this.app.workspace.onLayoutReady(() => {
      for (const event of ['create', 'rename', 'delete']) {
        this.registerEvent(this.app.vault.on(event, (file) => this.scheduleListsWriteBack(file)));
      }
      // Started now, so the first write-back doesn't wait for Raindown to load.
      if (this.settings.writeBack) this.serverFor().start();
      this.checkForUpdate();
    });
  }

  onunload() {
    this.timers.forEach((timer) => clearTimeout(timer));
    clearTimeout(this.listsTimer);
    this.server?.stop();
  }

  // The server for the Raindown command set now, made again when it changes.
  serverFor() {
    if (this.server?.command !== this.settings.command) {
      this.server?.stop();
      this.server = new RaindownServer(this.settings.command);
    }

    return this.server;
  }

  // Raindown's answer, through its server when it has one, or else from running it once, as { output, warnings }.
  async raindown({ file, markdown, rewrite = false, execute = false, timeout = TIMEOUT }) {
    const filePath = this.absolutePath(file);
    const bare = this.settings.bareSyntax;
    const answer = await this.serverFor().request({ path: filePath, markdown, rewrite, execute, bare }, { timeout });
    if (answer) return { output: answer.output, warnings: (answer.warnings ?? []).join('\n') };

    const args = rewrite ? rewriteArgs(filePath, { execute, bare }) : [filePath, '--stdin', ...(bare ? ['--bare'] : [])];
    return runRaindown(this.settings.command, args, markdown, { cwd: path.dirname(filePath), timeout });
  }

  withActiveNote(checking, action) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return false;
    if (!checking) action(file);

    return true;
  }

  scheduleWriteBack(file, delay = DELAY) {
    if (!this.settings.writeBack || file.extension !== 'md') return;

    clearTimeout(this.timers.get(file.path));
    this.timers.set(file.path, setTimeout(() => {
      this.timers.delete(file.path);
      this.writeBackInTurn(file);
    }, delay));
  }

  // One write-back of a note at a time, as each needs the table comments the last one wrote. Asked again meanwhile, it
  // runs once more when it's done, with the note as it is by then.
  async writeBackInTurn(file) {
    if (this.writing.has(file.path)) {
      this.writing.set(file.path, true);
      return;
    }

    this.writing.set(file.path, false);
    try {
      await this.writeBack(file);
    } finally {
      const again = this.writing.get(file.path);
      this.writing.delete(file.path);
      if (again) this.writeBackInTurn(file);
    }
  }

  // A note added, renamed or removed changes the lists in other notes, like list:, so they're written back.
  scheduleListsWriteBack(file) {
    if (!this.settings.writeBack || file.extension !== 'md') return;

    clearTimeout(this.listsTimer);
    this.listsTimer = setTimeout(() => this.writeBackAll((markdown) => LISTS.test(markdown)), DELAY);
  }

  // Writes back each note the test picks, one after another, and says how many changed if asked.
  async writeBackAll(test, { notify = false } = {}) {
    let changed = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (test(await this.app.vault.cachedRead(file), this.settings) && await this.writeBack(file, { force: true })) changed++;
    }
    if (notify) new Notice(`Wrote back ${changed} ${changed === 1 ? 'note' : 'notes'}`);
  }

  // Saving writes back quietly, showing errors in the status bar, as a directive that's half typed fails until it's
  // done. The commands say what happened. Forced, a note's written back even if it hasn't changed since. Returns
  // whether the note changed.
  async writeBack(file, { execute = false, notify = false, force = false } = {}) {
    const original = this.editorFor(file)?.getValue() ?? await this.app.vault.read(file);
    const unchanged = !force && this.written.get(file.path) === original;
    if (!notify && (unchanged || !hasDirectives(original, this.settings))) return false;

    const timeout = execute ? ENDPOINT_TIMEOUT : TIMEOUT;

    try {
      const { output: markdown, warnings } = await this.raindown({ file, markdown: original, rewrite: true, execute, timeout });
      // Raindown never empties a note, so nothing back, like from a wrapper script that failed, is an error.
      if (!markdown.trim() && original.trim()) throw new Error("Raindown didn't print the note back, so it's left as it is");
      if (markdown !== original) await this.applyToNote(file, original, markdown);

      this.written.set(file.path, markdown);
      this.showError(file, null);
      this.report(warnings, { notify, done: markdown === original ? 'Nothing to write back' : 'Written back' });
      return markdown !== original;
    } catch (error) {
      this.showError(file, errorLine(error.message));
      this.report(error.message, { notify });
      if (error.code === 'ENOENT') await this.findRaindown(file, { notify });
      return false;
    }
  }

  // Underlines the line of a note's error, or none, by updating its editors.
  showError(file, line) {
    if ((this.errors.get(file.path) ?? null) === line) return;

    if (line) this.errors.set(file.path, line);
    else this.errors.delete(file.path);
    this.app.workspace.updateOptions();
  }

  // A project's own nodes, from the .raindown folder in the note's folder or the nearest one above it.
  async projectNodes(file) {
    const adapter = this.app.vault.adapter;
    for (let folder = file?.parent?.path ?? ''; ; folder = path.posix.dirname(folder)) {
      const nodes = path.posix.join(folder === '/' ? '' : folder, '.raindown');
      if (await adapter.exists(nodes)) {
        const { files } = await adapter.list(nodes);
        return files.map((file) => /\/([A-Z]\w*)\.(?:rb|js|mjs|md|rd)$/.exec(file)?.[1]).filter(Boolean);
      }
      if (folder === '' || folder === '/' || folder === '.') return [];
    }
  }

  // Reading view shows a section with <{ }> in it, like <{ :toc }>, as Raindown renders it, which only Raindown can.
  async renderSection(el, context) {
    const section = context.getSectionInfo(el);
    const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
    const lines = section?.text.split('\n').slice(section.lineStart, section.lineEnd + 1).join('\n');
    if (!lines?.includes('<{') || !file) return;

    try {
      const rendered = await this.sectionHtmlFor(file, markSection(section.text, section.lineStart, section.lineEnd));
      if (rendered !== null) el.replaceChildren(sanitizeHTMLToDom(rendered));
    } catch {
      // Reading view keeps what Obsidian rendered. Saving the note shows the error.
    }
  }

  // Reading view renders a section again each time it's shown, like switching to it, so its HTML is kept until the
  // note changes, and a render that's under way is shared. Failed renders aren't kept.
  sectionHtmlFor(file, markdown) {
    const key = `${file.path}\0${markdown}`;
    if (!this.sections.has(key)) {
      const html = this.raindown({ file, markdown }).then(({ output }) => sectionHtml(output));
      html.catch(() => this.sections.delete(key));
      this.sections.set(key, html);
      if (this.sections.size > SECTIONS_KEPT) this.sections.delete(this.sections.keys().next().value);
    }

    return this.sections.get(key);
  }

  // An open note's changed in its editor, as typing it would be, which Obsidian then saves, rather than on disk under
  // it, which Obsidian reports as modified externally. Others are changed through the vault.
  async applyToNote(file, original, markdown) {
    const editor = this.editorFor(file);
    if (!editor) return this.app.vault.process(file, (current) => applyRewrite(current, original, markdown));
    const current = editor.getValue();
    if (current !== original) {
      const comments = tableCommentChanges(current, markdown);
      if (comments.length) editor.transaction({ changes: comments });
      return;
    }

    const changes = changedLines(original, markdown);
    if (!changes) {
      const { from, to, text } = changedRange(original, markdown);
      return editor.replaceRange(text, editor.offsetToPos(from), editor.offsetToPos(to));
    }

    const [anchor, head] = [editor.getCursor('anchor'), editor.getCursor('head')];
    editor.transaction({ changes });
    editor.setSelection(movedCursor(anchor, original, markdown), movedCursor(head, original, markdown));
  }

  editorFor(file) {
    return this.app.workspace.getLeavesOfType('markdown').map((leaf) => leaf.view).find((view) => view.file?.path === file.path)?.editor;
  }

  // The first time Raindown can't be found, it's looked for where it's downloaded to and on the shell's PATH, and
  // written back with if one there runs. If not, downloading it is offered, once, and only done if it's asked for.
  async findRaindown(file, { notify }) {
    if (this.searched) return;

    this.searched = true;
    const found = await firstRunning([fs.existsSync(binaryPath()) && binaryPath(), await shellRaindown()]);
    if (!found) {
      if (binaryName()) this.ask({
        title: 'Download Raindown?',
        text: `Raindown isn't installed, or Obsidian can't find one that runs. Download it from GitHub to ${binaryPath()}?`,
        action: 'Download',
        confirm: () => this.installRaindown()
      });
      return;
    }

    await this.useRaindown(found);
    await this.writeBack(file, { notify });
  }

  // Once a day at most, a binary the plugin downloaded is checked against the latest release, and updated if that's
  // asked for. Turning an update down skips that release. Offline, it's checked again the next day.
  async checkForUpdate(request = requestUrl) {
    if (this.settings.command !== binaryPath() || Date.now() - (this.settings.checkedAt || 0) < DAY) return;

    this.settings.checkedAt = Date.now();
    await this.saveData(this.settings);
    try {
      const tag = (await request({ url: LATEST_RELEASE })).json.tag_name;
      const { output: installed } = await runRaindown(binaryPath(), ['--version'], '', { timeout: TIMEOUT });
      if (tag === this.settings.skippedTag || !isNewer(tag, installed.trim())) return;

      this.ask({
        title: 'Update Raindown?',
        text: `Raindown ${tag.replace(/^v/, '')} is out, and you have ${installed.trim()}. Update it?`,
        action: 'Update',
        confirm: () => this.installRaindown(tag),
        cancel: async () => {
          this.settings.skippedTag = tag;
          await this.saveData(this.settings);
        }
      });
    } catch {
      // GitHub or the binary didn't answer, so there's nothing to offer.
    }
  }

  ask(options) {
    new ConfirmModal(this.app, options).open();
  }

  async installRaindown(tag) {
    const name = binaryName();
    if (!name) return new Notice('There\'s no Raindown binary for this computer. Install it with "gem install raindown".');

    try {
      new Notice('Downloading Raindown…');
      await downloadRaindown(name, binaryPath(), { tag, beforeReplacing: () => this.server?.stopAndWait() });
      this.server = null; // The next write-back starts the new binary.
      await this.useRaindown(binaryPath());
      new Notice(`Raindown is downloaded to ${binaryPath()}`);
    } catch (error) {
      new Notice(`Couldn't download Raindown: ${error.message}`);
    }
  }

  async useRaindown(command) {
    this.settings.command = command;
    await this.saveData(this.settings);
  }

  absolutePath(file) {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return path.join(adapter.getBasePath(), file.path);

    return file.path;
  }

  report(message, { notify, done }) {
    this.status.setText(message ? `Raindown: ${message.split('\n')[0]}` : '');
    if (notify) new Notice(message || done);
  }
}

// Asks before downloading anything, with the action, like Download, and Not now.
class ConfirmModal extends Modal {
  constructor(app, { title, text, action, confirm, cancel = () => {} }) {
    super(app);
    Object.assign(this, { title, text, action, confirm, cancel });
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.text });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Not now').onClick(() => {
        this.close();
        this.cancel();
      }))
      .addButton((button) => button.setButtonText(this.action).setCta().onClick(() => {
        this.close();
        this.confirm();
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class RaindownSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Raindown command')
      .setDesc('The raindown executable, or its full path')
      .addText((text) => text.setPlaceholder('raindown').setValue(this.plugin.settings.command).onChange(async (value) => {
        this.plugin.settings.command = value.trim() || DEFAULT_SETTINGS.command;
        await this.plugin.saveData(this.plugin.settings);
      }));

    this.addToggle('writeBack', 'Write-back', 'Write back to a note with directives as you type');
    this.addToggle('bareSyntax', 'Bare syntax', 'Recognise bare directives on their own line like toc: (equivalent to CLI --bare)');
  }

  addToggle(key, name, description) {
    new Setting(this.containerEl).setName(name).setDesc(description)
      .addToggle((toggle) => toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}

module.exports = RaindownPlugin;
Object.assign(module.exports, {
  applyRewrite, binaryName, binaryPath, changedLines, changedRange, directiveTokens, downloadRaindown, errorLine, errorMessage, expandCommand,
  DirectiveSuggest, hasDirectives, inFormulaCell, isNewer, markSection, movedCursor, rewriteArgs, sectionHtml, tableCommentChanges, tableLines,
  RaindownServer, runRaindown, shellRaindown
});
