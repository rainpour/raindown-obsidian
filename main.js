'use strict';

// Raindown for Obsidian: as a note's saved, Raindown writes back to it, like `raindown watch`, filling in its tables of
// contents, file lists, components and charts. Obsidian loads this one file, so it has no build step.
const childProcess = require('child_process');
const os = require('os');
const path = require('path');
const {
  EditorSuggest, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, editorInfoField, sanitizeHTMLToDom
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
// How long a new server has to start and give its first answer, as a new standalone binary unpacks itself first, and a
// note in a big vault, or one in cloud storage, can take a while to list.
const START_TIMEOUT = 60000;
// The oldest Raindown that works with the plugin, as earlier ones read notes as ASCII when Obsidian's opened from the
// Dock, and stop on the first accented letter.
const MINIMUM_VERSION = '0.15.0';
const MAX_BUFFER = 32 * 1024 * 1024;
const INSTALL_URL = 'https://raindown.dev/docs/obsidian#install';
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

// Takes the plugin's settings, so Bare syntax counts.
function hasDirectives(markdown, { bareSyntax = false } = {}) {
  return DIRECTIVE.test(markdown) || (bareSyntax && BARE_DIRECTIVE.test(markdown));
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
    return `Couldn't run "${command}". Install it from ${INSTALL_URL}, then run "Raindown: Find Raindown", or set its ` +
      "full path in the plugin's settings, since Obsidian doesn't always see your shell's PATH.";
  }

  // Raindown before --rewrite doesn't know it.
  if (stderr.startsWith('Unknown arguments') && stderr.includes('--rewrite')) {
    return `This Raindown is too old for the plugin. Update it from ${INSTALL_URL}`;
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

// Whether a version, like 0.11.0, is older than another, like 0.15.0.
function isOlder(version, than) {
  const [mine, theirs] = [version, than].map((text) => text.trim().replace(/^v/, '').split('.').map(Number));
  const index = theirs.findIndex((part, i) => part !== (mine[i] || 0));

  return index !== -1 && (mine[index] || 0) < theirs[index];
}

// "raindown server" keeps Raindown loaded, so writing back or rendering doesn't start Ruby again each time. It starts
// when it's first asked something, and again after it stops. A Raindown without it, from before it, or one that doesn't
// start, isn't asked again, and requests answer null, for running Raindown once each instead.
class RaindownServer {
  // onReady is given the version it says it is.
  constructor(command, onReady = () => {}) {
    this.command = command;
    this.onReady = onReady;
    this.pending = new Map();
    this.nextId = 1;
  }

  // Resolves with Raindown's answer, like { output, warnings }, or null without a server, or rejects with its error.
  async request(message, { timeout }) {
    if (!await this.start()) return null;

    let wait = timeout;
    if (!this.answered) wait = Math.max(timeout, START_TIMEOUT);

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop(); // Stuck, so the next request starts it again.
        reject(new Error(`Raindown didn't answer within ${wait / 1000} seconds`));
      }, wait);
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
      const timer = setTimeout(() => { unsupported(); child.kill(); }, START_TIMEOUT);
      let buffer = '';
      // What it last wrote to stderr, to say why it stopped. Read, too, so a full pipe can't stop it.
      let errors = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => { errors = (errors + chunk).slice(-4000); });

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
        const why = errors.trim().split('\n').at(-1);
        const stopped = why ? `Raindown stopped: ${why}` : 'Raindown stopped';
        this.pending.forEach(({ reject, timer: waiting }) => { clearTimeout(waiting); reject(new Error(stopped)); });
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
      this.onReady(message.version);
      return ready();
    }

    const request = this.pending.get(message.id);
    if (!request) return;
    this.answered = true;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message);
  }

  stop() {
    this.child?.kill();
  }
}

// Where the standalone binary's usually installed, which Obsidian opened from the Dock doesn't look in.
function binaryPath(platform = process.platform) {
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'raindown', 'raindown.exe');

  return path.join(os.homedir(), '.local', 'bin', 'raindown');
}

// The command to paste into a terminal, which installs Raindown, or updates it.
function installCommand(platform = process.platform) {
  if (platform === 'win32') return 'irm https://raindown.dev/install.ps1 | iex';

  return 'curl -fsSL https://raindown.dev/install.sh | sh';
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

// Changes the editor without adding to its undo history, so undo goes back through what was typed. Otherwise it undoes
// what Raindown wrote, like a table of contents, which is written straight back. Obsidian's editor can't say so, so
// it's dispatched to its CodeMirror view, or else made through Obsidian's editor, like in tests.
function changeOutsideHistory(editor, changes) {
  const view = editor.cm;
  if (!view) return editor.transaction({ changes });

  const { Transaction } = require('@codemirror/state');
  view.dispatch({
    changes: changes.map(({ from, to = from, text }) => ({ from: editor.posToOffset(from), to: editor.posToOffset(to), insert: text })),
    annotations: Transaction.addToHistory.of(false)
  });
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

// Whether the cursor's on a line with a directive, like table: data/books.csv, whose arguments might be half typed.
function onDirectiveLine(text, { line }, options) {
  const lines = text.split('\n');
  const start = lines.slice(0, line).join('\n').length + (line ? 1 : 0);
  const end = start + (lines[line] ?? '').length;

  return directiveTokens(text, options).some(({ from, type }) => ['name', 'self-closing'].includes(type) && from >= start && from <= end);
}

// Each table: directive's file, like 'data/books.csv', with where its line ends, for a button to open it there.
function tableFiles(text, options) {
  const tokens = directiveTokens(text, options);

  return tokens.flatMap((token, index) => {
    if (!/^:?table:?$/.test(text.slice(token.from, token.to))) return [];

    let lineEnd = text.indexOf('\n', token.to);
    if (lineEnd === -1) lineEnd = text.length;
    const data = directiveArgument(text.slice(token.to, lineEnd));
    if (!data) return [];

    return [{ at: lineEnd, data }];
  });
}

// The value after a directive's name, like its file, quoted or not, as Raindown reads it, up to any props, like
// data/books.csv in table: data/books.csv total: true, or null without one.
function directiveArgument(rest) {
  const text = rest.replace(/\s*(?:-->|\}>)\s*$/, '').trim();
  const quoted = /^(["'])(.*?)\1/.exec(text);
  if (quoted) return quoted[2];

  return /^(.*?)(?=\s+\w+(?:=|:\s)|$)/.exec(text)[1] || null;
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
  const { Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
  const { RangeSetBuilder } = require('@codemirror/state');
  // A button after a table: directive, opening its file.
  class OpenFileWidget extends WidgetType {
    constructor(data) {
      super();
      this.data = data;
    }

    eq(other) {
      return other.data === this.data;
    }

    toDOM(view) {
      const button = document.createElement('button');
      button.className = 'cm-raindown-open-file';
      button.textContent = `Open ${path.extname(this.data).slice(1).toUpperCase()}`;
      button.addEventListener('click', () => plugin.openTableFile(view.state.field(editorInfoField, false)?.file, this.data));
      return button;
    }
  }
  const marks = {
    error: Decoration.line({ class: 'cm-raindown-error' }),
    table: Decoration.line({ class: 'cm-raindown-table' })
  };
  const errorFor = (view) => plugin.errors.get(view.state.field(editorInfoField, false)?.file?.path) ?? null;
  const decorate = (view) => {
    const builder = new RangeSetBuilder();
    const line = errorFor(view);
    const markdown = view.state.doc.toString();
    const options = { bare: plugin.settings.bareSyntax };
    const buttons = tableFiles(markdown, options).map(({ at, data }) => ({
      from: at, to: at, decoration: Decoration.widget({ widget: new OpenFileWidget(data), side: 1 })
    }));
    const ranges = [...directiveTokens(markdown, options), ...tableLines(markdown), ...buttons];
    if (line && line <= view.state.doc.lines) ranges.unshift({ from: view.state.doc.line(line).from, type: 'error' });

    for (const { from, to, type, decoration } of ranges.sort((a, b) => a.from - b.from || (a.to ?? -1) - (b.to ?? -1))) {
      builder.add(from, to ?? from, decoration ?? (marks[type] ??= Decoration.mark({ class: `cm-raindown-${type}` })));
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

// The editor extension for a held write-back: a hint at the end of the directive's line, Enter there to write back
// without a new line, and writing back once the cursor's left the line.
function heldWriteBacks(plugin) {
  const { Decoration, ViewPlugin, WidgetType, keymap } = require('@codemirror/view');
  const { Prec } = require('@codemirror/state');
  class HintWidget extends WidgetType {
    eq() {
      return true;
    }

    toDOM() {
      const hint = document.createElement('span');
      hint.className = 'cm-raindown-hint';
      hint.textContent = '↵ Enter to update';
      return hint;
    }
  }
  const hint = Decoration.widget({ widget: new HintWidget(), side: 1 });
  const infoFor = (view) => view.state.field(editorInfoField, false);
  const decorate = (view) => {
    const info = infoFor(view);
    if (!info?.file || !plugin.held.has(info.file.path)) return Decoration.none;

    return Decoration.set([hint.range(view.state.doc.lineAt(view.state.selection.main.head).to)]);
  };

  return [
    ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = decorate(view); }
      update(update) {
        if (update.selectionSet) plugin.cursorMoved(infoFor(update.view));
        this.decorations = decorate(update.view);
      }
    }, { decorations: (instance) => instance.decorations }),
    Prec.high(keymap.of([{ key: 'Enter', run: (view) => plugin.confirmHeld(infoFor(view)) }]))
  ];
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
    // Notes whose write-back waits for the cursor to leave a directive's line.
    this.held = new Set();
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
    this.addCommand({ id: 'find', name: 'Find Raindown', callback: () => this.findInstalledRaindown() });
    this.addCommand({
      id: 'open-table-file',
      name: "Open this table's file",
      editorCheckCallback: (checking, editor, view) => {
        const table = this.tableAtCursor(editor);
        if (table && !checking) this.openTableFile(view.file, table.data);
        return Boolean(table);
      }
    });
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      if (info.file) this.scheduleWriteBack(info.file, typingDelay(editor));
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => this.scheduleWriteBack(file)));
    // The line of each note's error, for the editor to underline.
    this.errors = new Map();
    this.registerEditorExtension(highlighting(this));
    this.registerEditorExtension(heldWriteBacks(this));
    this.registerEditorSuggest(new DirectiveSuggest(this.app, this));
    this.registerMarkdownPostProcessor((el, context) => this.renderSection(el, context));
    // Obsidian adds every file as it loads, so lists are only written back for notes added after that.
    this.app.workspace.onLayoutReady(() => {
      for (const event of ['create', 'rename', 'delete']) {
        this.registerEvent(this.app.vault.on(event, (file) => this.scheduleListsWriteBack(file)));
      }
      // Started now, so the first write-back doesn't wait for Raindown to load.
      if (this.settings.writeBack) this.serverFor().start();
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
      this.server = new RaindownServer(this.settings.command, (version) => this.checkVersion(version));
    }

    return this.server;
  }

  // Raindown's answer, through its server when it has one, or else from running it once, as { output, warnings }.
  async raindown({ file, markdown, rewrite = false, execute = false, timeout = TIMEOUT }) {
    const filePath = this.absolutePath(file);
    const bare = this.settings.bareSyntax;
    const answer = await this.serverFor().request({ path: filePath, markdown, rewrite, execute, bare }, { timeout });
    if (answer) return { output: answer.output, warnings: (answer.warnings ?? []).join('\n') };
    this.checkVersionOf(this.settings.command);

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
  async writeBackInTurn(file, options = {}) {
    if (this.writing.has(file.path)) {
      this.writing.set(file.path, true);
      return;
    }

    this.writing.set(file.path, false);
    try {
      await this.writeBack(file, options);
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
  async writeBack(file, { execute = false, notify = false, force = false, confirmed = false } = {}) {
    if (!notify && !confirmed && this.holdWhileOnDirective(file)) return false;

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
      this.report(this.shortMessage(warnings, file), { notify, done: markdown === original ? 'Nothing to write back' : 'Written back' });
      return markdown !== original;
    } catch (error) {
      this.showError(file, errorLine(error.message));
      this.report(this.shortMessage(error.message, file), { notify });
      if (error.code === 'ENOENT') await this.findRaindown(file, { notify });
      return false;
    }
  }

  // Whether to wait to write back while the cursor's on a directive's line, as what's typed there is often half done,
  // like a path, and table: would make a file for each, like test.csv, rtest.csv and ratest.csv. The commands don't.
  holdWhileOnDirective(file) {
    const editor = this.editorFor(file);
    if (!editor || !onDirectiveLine(editor.getValue(), editor.getCursor(), { bare: this.settings.bareSyntax })) return false;

    if (!this.held.has(file.path)) {
      this.held.add(file.path);
      this.app.workspace.updateOptions(); // Shows the hint.
    }
    return true;
  }

  // Enter on a held directive's line writes back, rather than starting a new line, which would split the directive.
  confirmHeld(info) {
    if (!info?.file || !this.held.has(info.file.path)) return false;
    if (!onDirectiveLine(info.editor.getValue(), info.editor.getCursor(), { bare: this.settings.bareSyntax })) return false;

    this.held.delete(info.file.path);
    this.app.workspace.updateOptions(); // Hides the hint.
    this.writeBackInTurn(info.file, { confirmed: true });
    return true;
  }

  // Writes back a held note once its cursor has left the directive's line.
  cursorMoved(info) {
    if (!info?.file || !this.held.has(info.file.path)) return;
    if (onDirectiveLine(info.editor.getValue(), info.editor.getCursor(), { bare: this.settings.bareSyntax })) return;

    this.held.delete(info.file.path);
    this.scheduleWriteBack(info.file, 0);
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
    const nodes = path.posix.join(await this.projectRoot(file), '.raindown');
    if (!await this.app.vault.adapter.exists(nodes)) return [];

    const { files } = await this.app.vault.adapter.list(nodes);
    return files.map((file) => /\/([A-Z]\w*)\.(?:rb|js|mjs|md|rd)$/.exec(file)?.[1]).filter(Boolean);
  }

  // The folder Raindown reads a note's files from, like a table's: the nearest with a .raindown folder, or the vault.
  async projectRoot(file) {
    for (let folder = file?.parent?.path ?? ''; ; folder = path.posix.dirname(folder)) {
      if (folder === '/' || folder === '.') folder = '';
      if (await this.app.vault.adapter.exists(path.posix.join(folder, '.raindown'))) return folder;
      if (folder === '') return '';
    }
  }

  // Opens a table's file in the app the computer opens it with, like Numbers or Excel, as Obsidian doesn't open CSV
  // files. Editing it there changes the table in the note too.
  async openTableFile(file, data) {
    const found = path.posix.normalize(path.posix.join(await this.projectRoot(file), data));
    if (found.startsWith('..')) return new Notice(`${data} isn't in the vault`);
    if (!await this.app.vault.adapter.exists(found)) return new Notice(`${data} is made when the note's written back`);
    if (this.app.openWithDefaultApp) return this.app.openWithDefaultApp(found);

    return require('electron').shell.openPath(path.join(this.app.vault.adapter.getBasePath(), found));
  }

  // The table: directive at the cursor, or the nearest above it.
  tableAtCursor(editor) {
    const { line } = editor.getCursor();
    const cursorLineEnd = editor.posToOffset({ line, ch: editor.getLine(line).length });
    return tableFiles(editor.getValue(), { bare: this.settings.bareSyntax }).filter(({ at }) => at <= cursorLineEnd).at(-1);
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
      if (comments.length) changeOutsideHistory(editor, comments);
      return;
    }

    const changes = changedLines(original, markdown);
    if (!changes) {
      const { from, to, text } = changedRange(original, markdown);
      return changeOutsideHistory(editor, [{ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text }]);
    }

    const [anchor, head] = [editor.getCursor('anchor'), editor.getCursor('head')];
    changeOutsideHistory(editor, changes);
    editor.setSelection(movedCursor(anchor, original, markdown), movedCursor(head, original, markdown));
  }

  editorFor(file) {
    return this.app.workspace.getLeavesOfType('markdown').map((leaf) => leaf.view).find((view) => view.file?.path === file.path)?.editor;
  }

  // The first time Raindown can't be found, it's looked for where it's usually installed and on the shell's PATH, and
  // written back with if one there runs. If not, how to install it is shown, once. The plugin never installs it itself,
  // as Obsidian's developer policies don't allow that.
  async findRaindown(file, { notify }) {
    if (this.searched) return;

    this.searched = true;
    if (await this.useInstalledRaindown()) await this.writeBack(file, { notify });
    else new InstallModal(this.app, () => this.findInstalledRaindown()).open();
  }

  // Looks again, once it's been installed, and says what it found.
  async findInstalledRaindown() {
    const found = await this.useInstalledRaindown();
    if (found) new Notice(`Found Raindown at ${this.settings.command}`);
    else new Notice("Couldn't find Raindown");

    return found;
  }

  // Whether a Raindown that runs was found, which is then the one used.
  async useInstalledRaindown() {
    const found = await firstRunning([binaryPath(), await shellRaindown()]);
    if (found) await this.useRaindown(found);

    return Boolean(found);
  }

  // An old Raindown, like one the plugin used to download, is shown how to update it, once until another's found.
  checkVersion(version) {
    if (this.warnedOld || !version || !isOlder(version, MINIMUM_VERSION)) return;

    this.warnedOld = true;
    new InstallModal(this.app, () => this.findInstalledRaindown(), { old: version.trim() }).open();
  }

  // A Raindown without a server says its version when asked, once for each command.
  checkVersionOf(command) {
    if (this.checkedCommand === command) return;

    this.checkedCommand = command;
    runRaindown(command, ['--version'], '', { timeout: TIMEOUT }).then(({ output }) => this.checkVersion(output), () => {});
  }

  // A server that couldn't start before it was installed isn't asked again, so the next write-back starts a new one.
  async useRaindown(command) {
    this.server?.stop();
    this.server = null;
    this.warnedOld = false;
    this.settings.command = command;
    await this.saveData(this.settings);
  }

  absolutePath(file) {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return path.join(adapter.getBasePath(), file.path);

    return file.path;
  }

  // Raindown's message, which names files by their full path, like in a terminal, without the note's own, as it's the
  // one it's about, others' from the vault, which in cloud storage is long, or Raindown's name, as the status has it.
  shortMessage(message, file) {
    const adapter = this.app.vault.adapter;
    let short = message.replace(/^raindown: /gm, '').replaceAll(`${this.absolutePath(file)}: `, '');
    if (adapter instanceof FileSystemAdapter) short = short.replaceAll(path.join(adapter.getBasePath(), path.sep), '');

    return short;
  }

  report(message, { notify, done }) {
    this.status.setText(message ? `Raindown: ${message.split('\n')[0]}` : '');
    if (notify) new Notice(message || done);
  }
}

// Shows how to install Raindown, or update an old one, and looks for it again once that's done.
class InstallModal extends Modal {
  constructor(app, check, { old } = {}) {
    super(app);
    this.check = check;
    this.old = old;
  }

  onOpen() {
    const { title, why, how } = this.wording();
    this.titleEl.setText(title);
    this.contentEl.createEl('p', { text: why });
    this.contentEl.createEl('p', { text: `${how}, paste this into a terminal, then select Check again:` });
    this.contentEl.createEl('pre').createEl('code', { text: installCommand() });
    this.contentEl.createEl('a', { text: 'More ways to install Raindown', href: INSTALL_URL });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Not now').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Copy').onClick(async () => {
        await navigator.clipboard.writeText(installCommand());
        new Notice('Copied');
      }))
      .addButton((button) => button.setButtonText('Check again').setCta().onClick(async () => {
        if (await this.check()) this.close();
      }));
  }

  onClose() {
    this.contentEl.empty();
  }

  wording() {
    if (!this.old) {
      return { title: 'Install Raindown', why: "This plugin needs the raindown program, and Obsidian can't find one that runs.", how: 'To install it' };
    }

    return { title: 'Update Raindown', why: `This plugin needs Raindown ${MINIMUM_VERSION} or newer, and you have ${this.old}.`, how: 'To update it' };
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
  applyRewrite, binaryPath, changedLines, changedRange, directiveTokens, errorLine, errorMessage, expandCommand,
  DirectiveSuggest, hasDirectives, inFormulaCell, installCommand, isOlder, markSection, movedCursor, rewriteArgs, sectionHtml, tableCommentChanges, tableLines,
  RaindownServer, changeOutsideHistory, onDirectiveLine, runRaindown, shellRaindown, tableFiles
});
