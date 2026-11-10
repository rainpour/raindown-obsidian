'use strict';

// Raindown for Obsidian: as a note's saved, Raindown writes back to it, like `raindown watch`, filling in its tables of
// contents, file lists, components and charts. Raindown runs inside the plugin, in Ruby compiled to WebAssembly, which
// src/engine.js starts. bin/build builds main.js, which Obsidian loads, from this folder.
const {
  EditorSuggest, MarkdownRenderer, Notice, Platform, Plugin, PluginSettingTab, Setting, Vault, editorInfoField
} = require('obsidian');
const { RaindownEngine } = require('./engine');

const DEFAULT_SETTINGS = { writeBack: true, bareSyntax: false };
// A note's written back this long after each key, before Obsidian's even saved it, or once a change from outside the
// editor, like a sync, has been saved for DELAY. Typing a formula in a table waits for DELAY too, as
// =sum(c) is already whole on the way to =sum(cost), with Obsidian closing its bracket.
const TYPING_DELAY = 0;
const DELAY = 1000;
// A comment on its own line that isn't a directive, which straight below a directive is its node's comment, like
// table:'s <!-- 2 rows · 3f2a9c -->, as Raindown reads it.
const BLOCK_COMMENT = /^\s*<!--(?!\s*(?::[A-Za-z]|[A-Za-z][\w-]*(?:::[A-Z]\w*)*:)).*-->\s*$/;
const TIMEOUT = 10000;
const ENDPOINT_TIMEOUT = 60000;
// Each section of reading view with <{ }> in it is rendered with the whole note, between these, then picked out.
const SECTION_START = '<!-- raindown:section -->';
const SECTION_END = '<!-- raindown:end-section -->';
// How many sections' Markdown reading view keeps.
const SECTIONS_KEPT = 50;
// Shown below the Bare syntax setting, as a bare directive writes over the lines below it, up to the next blank line.
const BARE_SYNTAX_WARNING = 'Make sure your files are version controlled or backed up before enabling bare syntax, ' +
  'otherwise existing content beneath text like "list:" could be overwritten';
// Notes listing others, which a note being added, renamed or removed changes.
const LISTS = /(?:<!--\s*|<\{\s*|^ {0,3})list:/m;
// Raindown's directives, for completing their names. A project's own nodes in .raindown/ are added to them.
const BUILT_INS = ['chart', 'endpoint', 'for', 'if', 'list', 'schema', 'table', 'toc'];
// A content directive in a comment, like <!-- toc: --> or <!-- Changelog: -->, or front matter allowing bare ones.
// Saves of notes without them don't start Raindown.
const DIRECTIVE = /<!--\s*[A-Za-z][\w:]*:|^raindown:\s*true\s*$/m;
// With bare directives in every note, a line starting with a name and a colon, like toc:, might be one too.
const BARE_DIRECTIVE = /^ {0,3}[A-Za-z]\w*:(?:\s|$)/m;

// The path in the vault the parts make, like notes/../data.csv as data.csv, which starts with .. when it's outside it.
// Obsidian's mobile apps don't have Node's path.
function vaultPath(...parts) {
  return parts.join('/').split('/').reduce((resolved, part) => {
    if (part === '..' && resolved.length && resolved.at(-1) !== '..') resolved.pop();
    else if (part && part !== '.') resolved.push(part);
    return resolved;
  }, []).join('/');
}

// The Markdown Raindown rendered between a section's markers, from the whole note's.
function sectionMarkdown(markdown) {
  const start = markdown.indexOf(SECTION_START);
  const end = markdown.indexOf(SECTION_END);
  if (start === -1 || end === -1) return null;

  return markdown.slice(start + SECTION_START.length, end);
}

// The note with a section's lines between markers, each a block of its own, so Raindown keeps them where they are.
function markSection(text, lineStart, lineEnd) {
  const lines = text.split('\n');
  lines.splice(lineEnd + 1, 0, '', SECTION_END, '');
  lines.splice(lineStart, 0, '', SECTION_START, '');

  return lines.join('\n');
}

// Takes the plugin's settings, so Bare syntax counts.
function hasDirectives(markdown, { bareSyntax = false } = {}) {
  return DIRECTIVE.test(markdown) || (bareSyntax && BARE_DIRECTIVE.test(markdown));
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

// The changes to the note's comments, last first, to those Raindown just wrote, like table:'s. It wrote their files
// too, so when the note's changed since, its comments must still say so, or the next write-back reads as a conflict.
function blockCommentChanges(current, markdown) {
  const comments = (text) => text.split('\n').flatMap((line, number) => (BLOCK_COMMENT.test(line) ? [{ line, number }] : []));
  const [oldComments, newComments] = [comments(current), comments(markdown)];
  if (oldComments.length !== newComments.length) return [];

  return oldComments.flatMap(({ line, number }, index) => {
    if (line === newComments[index].line) return [];

    return [{ from: { line: number, ch: 0 }, to: { line: number, ch: line.length }, text: newComments[index].line }];
  }).reverse();
}

// Where the cursor belongs on its line once it's changed: after the same text, however its spaces moved, and after a
// space it just typed, as lining up a table trims that from its cell, where the next word would need it. In a table's
// row, it's in the same cell, so another cell clipped or lined up doesn't move it along.
function movedCursor({ line, ch }, before, after) {
  const head = before.split('\n')[line].slice(0, ch);
  const text = after.split('\n')[line];
  const [headCells, cells] = [head, text].map((row) => row.split(/(?<!\\)\|/));
  const cell = headCells.length - 1;
  if (!/^[ \t]*[|+]/.test(head) || !/^[ \t]*[|+]/.test(text) || cells.length <= cell) return { line, ch: movedWithin(head, text) };

  const start = cells.slice(0, cell).reduce((offset, before) => offset + before.length + 1, 0);
  return { line, ch: start + movedWithin(headCells[cell], cells[cell]) };
}

// How far into the text the cursor goes to be after the head's text, however its spaces moved.
function movedWithin(head, text) {
  const wanted = head.replace(/\s/g, '').length;
  let [moved, seen] = [0, 0];
  for (; seen < wanted && moved < text.length; moved++) {
    if (!/\s/.test(text[moved])) seen++;
  }
  // Text that's shorter now, like a cell clipped, has the cursor after its last letter, not its padding.
  if (seen < wanted) return text.trimEnd().length;
  if (/\s$/.test(head) && /\s/.test(text[moved] ?? '')) moved++;

  return moved;
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

// From each directive's name to the end of its line, like toc: or table: data/books.csv, total: true, so the editor
// doesn't spell check its names, props and paths, while the Markdown it writes below is checked like any other.
// The row of a table the cursor's in, with the |+ rows carrying it on: the lines it spans, the column the cursor's in,
// the line its table starts on, whether it's the header or the delimiter row below it, and the line of the row below
// it, or null outside a table's rows.
function tableRowAt(lines, { line, ch }) {
  const row = (number) => /^\s*[|+]/.test(lines[number] ?? '') && lines[number].trim();
  let start = line;
  while (start > 0 && row(start - 1)) start--;
  if (!row(line) || !isTableStart(lines, start)) return null;

  const lead = lines[line].search(/[|+]/);
  if (ch <= lead) return null;

  let [first, last] = [line, line];
  while (first > start + 2 && CONTINUATION.test(lines[first])) first--;
  while (CONTINUATION.test(lines[last + 1] ?? '')) last++;
  const header = line === start;
  const below = header ? start + 2 : last + 1;
  const column = [...lines[line].slice(lead + 1, ch).matchAll(/(?<!\\)\|/g)].length;
  return { start, first, last, column, header, delimiter: line === start + 1, next: row(below) ? below : null };
}

// Whether the table starting on the line is a table: block's, below its directive and its comment.
function underTableDirective(text, lines, start, options) {
  const above = BLOCK_COMMENT.test(lines[start - 1] ?? '') ? start - 1 : start;
  const directiveEnd = lines.slice(0, above).join('\n').length;
  return tableFiles(text, options).some(({ at }) => at === directiveEnd);
}

// What Enter does to the cell the cursor's in, in a table: block's table, each cell of a row on its own: 'collapse' one
// shown in full on |+ rows, or 'expand' one cut to fit, ending in an ellipsis, deleting it so Raindown shows its full
// text. Elsewhere it's null, and Enter only moves to the row below.
function cellToggle(text, lines, row, options) {
  if (!underTableDirective(text, lines, row.start, options)) return null;

  const below = lines.slice(row.first + 1, row.last + 1).map(tableCells);
  if (below.some((cells) => cells[row.column])) return 'collapse';
  if (tableCells(lines[row.first])[row.column]?.endsWith('…')) return 'expand';
  return null;
}

// Whether the cursor's in a table: block's fixed column, like |=====|, or on the |+ rows of a cell in one.
function inFixedCell(text, cursor, options) {
  const lines = text.split('\n');
  const row = tableRowAt(lines, cursor);
  if (!row || row.delimiter || !fixedColumn(tableCells(lines[row.start + 1])[row.column] ?? '')) return false;

  return underTableDirective(text, lines, row.start, options);
}

// What Enter does to the cell at the offset, for its hint.
function cellToggleAt(text, offset, options) {
  const lines = text.split('\n');
  const row = tableRowAt(lines, positionOf(text, offset));
  return row && cellToggle(text, lines, row, options);
}

// Where a cell is in a row's line, from after the pipe before it to the pipe after it, or null past its last.
function cellBounds(line, column) {
  const lead = line.match(/^[ \t]*\|\+?/)?.[0].length ?? 0;
  const pipes = [...line.matchAll(/(?<!\\)\|/g)].map(({ index }) => index).filter((index) => index >= lead);
  const from = column === 0 ? lead : pipes[column - 1] + 1;
  if (Number.isNaN(from)) return null;

  return { from, to: pipes[column] ?? line.length };
}

// Where the cursor goes to be at the end of a cell's text in a row's line: after its last letter, or inside it when
// it's empty.
function cellEndIn(line, column) {
  const cell = cellBounds(line, column);
  if (!cell) return line.length;

  return cell.from + Math.max(1, line.slice(cell.from, cell.to).trimEnd().length);
}

// An empty row for the row's table, indented like it, which the table lines up.
function emptyRow(lines, row) {
  const cells = tableCells(lines[row.start + 1]).map(() => '');
  return `${lines[row.first].match(/^[ \t]*/)[0]}| ${cells.join(' | ')} |`;
}

// A row and its |+ rows with one column's cell joined back onto the row's line, its parts joined with spaces, leaving
// the other columns' cells as they are, and the |+ rows nothing's left on out.
function collapsedColumn(rows, column) {
  const cells = rows.map(tableCells);
  const indent = rows[0].match(/^[ \t]*/)[0];
  const joined = cells.map((row) => row[column] ?? '').filter(Boolean).join(' ');
  const first = cells[0].map((cell, index) => (index === column ? joined : cell));
  const below = cells.slice(1).map((row) => row.map((cell, index) => (index === column ? '' : cell))).filter((row) => row.some(Boolean));
  return [`${indent}| ${first.join(' | ')} |`, ...below.map((row) => `${indent}|+${row.join(' | ')} |`)];
}

// The change Enter makes in a table's row, like in a spreadsheet: done with the cell, moving the cursor to the end of the
// same cell in the row below, which is added in the last row. In a table: block's table, it expands a cell cut to fit,
// staying in it, and collapses one shown in full, joining its text on the |+ rows back onto its row first, so Raindown
// clips it again. As offsets, with what it toggled, or null outside a table's rows.
function enteredCell(text, offset, options) {
  const lines = text.split('\n');
  const row = tableRowAt(lines, positionOf(text, offset));
  if (!row) return null;

  const toggle = cellToggle(text, lines, row, options);
  if (toggle === 'expand') return expandedCell(text, lines, row);

  const rows = lines.slice(row.first, row.last + 1);
  const kept = toggle === 'collapse' ? collapsedColumn(rows, row.column) : rows;
  // In the last row, a row's added below it to move to, like a spreadsheet's next row.
  const added = row.next === null && !row.header ? [emptyRow(lines, row)] : [];
  const insert = [...kept, ...added].join('\n');
  const from = offsetOf(text, { line: row.first, ch: 0 });
  const to = offsetOf(text, { line: row.last, ch: lines[row.last].length });
  const after = text.slice(0, from) + insert + text.slice(to);
  const target = row.next === null ? row.first + kept.length - 1 + added.length : row.next - (rows.length - kept.length);
  const cursor = offsetOf(after, { line: target, ch: cellEndIn(after.split('\n')[target], row.column) });

  return { from, to, insert, cursor, toggle };
}

// The change expanding a cell cut to fit: its ellipsis deleted, with the cursor where it was.
function expandedCell(text, lines, row) {
  const line = lines[row.first];
  const cell = cellBounds(line, row.column);
  const at = offsetOf(text, { line: row.first, ch: line.lastIndexOf('…', cell.to) });
  return { from: at, to: at + 1, insert: '', cursor: at, toggle: 'expand' };
}

// Where Tab moves the cursor in a table's row, like in a spreadsheet: to the end of the next cell's text on its line, or
// the first of the row below, or with back, like Shift and Tab, the previous cell, or the last of the row above. It
// stays put in the table's last cell, or first, so Tab never splits a row. Null outside a table's rows.
function tabbedCell(text, offset, { back = false } = {}) {
  const lines = text.split('\n');
  const position = positionOf(text, offset);
  const row = tableRowAt(lines, position);
  if (!row) return null;

  const { line } = position;
  const columns = tableCells(lines[row.start + 1]).length;
  const at = (number, column) => offsetOf(text, { line: number, ch: cellEndIn(lines[number], column) });
  const column = row.column + (back ? -1 : 1);
  if (column >= 0 && column < columns) return at(line, column);
  if (!back) return row.next === null ? at(line, row.column) : at(row.next, 0);

  let above = row.first - 1;
  if (above === row.start + 1) above = row.start;
  while (above > row.start + 2 && CONTINUATION.test(lines[above])) above--;
  return above < row.start ? at(line, row.column) : at(above, columns - 1);
}

// The change Option or Alt and Enter makes in a table's cell, like a line break in a spreadsheet: a |+ row below the
// cursor's row carrying the cell on, with what's after the cursor in it, rather than splitting the row, which would
// end the table. As offsets, with where the cursor goes, or null outside a table's rows, or in its header or
// delimiter row.
function carriedOnCell(text, offset) {
  const lines = text.split('\n');
  const { line, ch } = positionOf(text, offset);
  const row = tableRowAt(lines, { line, ch });
  if (!row || row.header || row.delimiter) return null;

  const { column } = row;
  const current = lines[line];
  const cellEnd = current.slice(ch).search(/(?<!\\)\|/);
  const end = cellEnd === -1 ? current.length : ch + cellEnd;
  const carried = `|+${' | '.repeat(column)}`;
  const cells = tableCells(lines[row.start + 1]).map((_, index) => (index === column ? current.slice(ch, end).trim() : ''));
  const from = offsetOf(text, { line, ch: 0 });
  const insert = `${current.slice(0, ch).trimEnd()} ${current.slice(end)}\n|+${cells.join(' | ')} |`;

  return { from, to: from + current.length, insert, cursor: from + insert.indexOf('\n') + 1 + carried.length };
}

function directiveLines(text, tokens) {
  return tokens.filter(({ type }) => ['name', 'self-closing'].includes(type)).map(({ from }) => {
    let to = text.indexOf('\n', from);
    if (to === -1) to = text.length;

    return { from, to };
  });
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
// data/books.csv in table: data/books.csv total: true, or table: data/books.csv, total: true, or null without one.
function directiveArgument(rest) {
  const text = rest.replace(/\s*(?:-->|\}>)\s*$/, '').trim();
  const quoted = /^(["'])(.*?)\1/.exec(text);
  if (quoted) return quoted[2];

  return /^(.*?)(?=(?:,[ \t]*|\s+)\w+(?:=|:\s)|,?\s*$)/.exec(text)[1] || null;
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

// The start of each line of a Markdown table, and its |+ rows, as Raindown's columns only line up in a monospace font,
// with its header, to show in bold, its delimiter row, to show muted, and its pipes, to show faint, but for those of a
// row carrying one on, its |+ and pipes, in the accent colour.
function tableLines(markdown) {
  const lines = markdown.split('\n');
  let offset = 0;
  return lines.flatMap((line, number) => {
    const from = offset;
    offset += line.length + 1;
    if (!/^[ \t]*\|.*\|[ \t]*$/.test(line)) return [];

    const header = isTableStart(lines, number) ? [{ from, to: from + line.length, type: 'table-header' }] : [];
    const delimiter = number > 0 && isTableStart(lines, number - 1) ? [{ from, to: from + line.length, type: 'table-delimiter' }] : [];
    // A row carrying on the one above has its |+ and pipes in the accent colour, so it's plain it's part of that row.
    const type = CONTINUATION.test(line) ? 'table-expansion' : 'table-pipe';
    const pipes = [...line.matchAll(/(?<!\\)\||(?<=^[ \t]*\|)\+/g)].map(({ index }) => ({ from: from + index, to: from + index + 1, type }));
    return [{ from, type: 'table' }, ...header, ...delimiter, ...pipes];
  });
}

// Lining up tables as they're typed, the same as Raindown's TableFormatter, so its write-back finds them lined up.
const DELIMITER_CELL = /^:?[-=]+:?$/;
// A row carrying on the one above it, starting with |+ in place of a row's "| ", which Raindown joins into its cells.
const CONTINUATION = /^[ \t\n\v\f\r]*\|\+/;
const FENCE = /^\s*(```|~~~)/;
// Ruby's strip, which leaves other spaces, like a no-break space, in the cell.
const STRIP = /^[ \t\n\v\f\r\0]+|[ \t\n\v\f\r\0]+$/g;
// East Asian wide and fullwidth letters, and emoji, take two columns, like unicode-display-width's with emoji: :all.
const WIDE = new RegExp(String.raw`[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF` +
  String.raw`\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}\uFE0F\u20E3]` +
  String.raw`|\p{Emoji_Presentation}`, 'u');
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;
const graphemes = new Intl.Segmenter();

function displayWidth(text) {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (WIDE.test(segment)) width += 2;
    else if (!ZERO_WIDTH.test(segment)) width += 1;
  }
  return width;
}

// How a row's line starts, before its first cell: |+ when it carries on the row above, as wide as a row's "| ".
function rowLead(line) {
  return CONTINUATION.test(line) ? '|+' : '| ';
}

// A row's cells, split on pipes that aren't escaped, without its outer pipes, or the |+ starting a continuation row.
function tableCells(line) {
  let content = line.replace(STRIP, '');
  const lead = rowLead(line).trimEnd();
  if (content.startsWith(lead)) content = content.slice(lead.length);
  if (content.endsWith('|') && !content.endsWith('\\|')) content = content.slice(0, -1);
  if (!content) return [];

  return content.split(/(?<!\\)\|/).map((cell) => cell.replace(STRIP, ''));
}

function isTableStart(lines, index) {
  const [header, delimiter] = [lines[index], lines[index + 1]];
  if (!header.includes('|') || delimiter === undefined || CONTINUATION.test(header)) return false;

  const cells = tableCells(delimiter);
  if (!cells.length || cells.length !== tableCells(header).length) return false;

  return cells.every((cell) => DELIMITER_CELL.test(cell));
}

// A column, like Raindown's TableColumn: its alignment, from its delimiter cell's colons, and its width, that of its
// widest cell, or as wide as its delimiter when that's equals signs, which is fixed, letting a longer cell run past.
// Whether a column's delimiter cell makes it fixed, like Raindown's TableColumn: equals signs, or one typed into dashes,
// as fewer of them than dashes, while a dash typed into equals signs makes it widen again.
function fixedColumn(delimiter) {
  const [equals, dashes] = ['=', '-'].map((sign) => delimiter.split(sign).length - 1);
  return equals > 0 && (dashes === 0 || equals < dashes);
}

function tableColumn(delimiter, cells) {
  const fixed = fixedColumn(delimiter);
  // An equals sign typed into dashes isn't part of its width, so it's fixed as wide as it was.
  const typed = delimiter.includes('-') ? delimiter.split('=').length - 1 : 0;
  const width = fixed ? delimiter.length - typed : Math.max(3, ...cells.map(displayWidth));
  const dash = fixed ? '=' : '-';
  let alignment = null;
  if (delimiter.startsWith(':') && delimiter.endsWith(':')) alignment = 'center';
  else if (delimiter.endsWith(':')) alignment = 'right';
  else if (delimiter.startsWith(':')) alignment = 'left';

  return {
    pad(cell) {
      const padding = Math.max(0, width - displayWidth(cell));
      if (alignment === 'center') return ' '.repeat(Math.floor(padding / 2)) + cell + ' '.repeat(Math.ceil(padding / 2));
      if (alignment === 'right') return ' '.repeat(padding) + cell;
      return cell + ' '.repeat(padding);
    },
    delimiterCell() {
      if (alignment === 'center') return `:${dash.repeat(width - 2)}:`;
      if (alignment === 'right') return `${dash.repeat(width - 1)}:`;
      if (alignment === 'left') return `:${dash.repeat(width - 1)}`;
      return dash.repeat(width);
    }
  };
}

// A table's lines with each column padded to fit, keeping each row's + when it carries on the row above, or as they
// were when a row has more cells than its header.
function alignedTable(table) {
  const indent = table[0].match(/^[ \t\n\v\f\r]*/)[0];
  const [header, delimiter, ...body] = table.map(tableCells);
  if (body.some((row) => row.length > header.length)) return table;

  const rows = [header, ...body.map((row) => [...row, ...Array(header.length - row.length).fill('')])];
  const columns = delimiter.map((cell, column) => tableColumn(cell, rows.map((row) => row[column])));
  const line = (lead, cells) => `${indent}${lead}${cells.join(' | ')} |`;
  const lines = [table[0], ...table.slice(2)].map((original, row) => line(rowLead(original), rows[row].map((cell, column) => columns[column].pad(cell))));

  return [lines[0], line('| ', columns.map((column) => column.delimiterCell())), ...lines.slice(1)];
}

// The note with every table lined up, outside code. Like Raindown, one lined up at the very end gets a line break
// after it.
function alignTables(markdown) {
  const lines = markdown.split('\n');
  const output = [];
  let inFence = false;
  for (let index = 0; index < lines.length;) {
    if (FENCE.test(lines[index])) inFence = !inFence;
    if (inFence || !isTableStart(lines, index)) {
      output.push(lines[index++]);
      continue;
    }

    let end = index + 2;
    while (end < lines.length && lines[end].includes('|') && lines[end].trim()) end++;
    const table = lines.slice(index, end);
    const aligned = alignedTable(table);
    output.push(...aligned, ...(end === lines.length && aligned !== table ? [''] : []));
    index = end;
  }
  return output.join('\n');
}

function offsetOf(text, { line, ch }) {
  return text.split('\n').slice(0, line).reduce((offset, before) => offset + before.length + 1, ch);
}

function positionOf(text, offset) {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, ch: lines.at(-1).length };
}

// The changes lining up the note's tables, as offsets in it, and where the selection goes after them, or null when
// they're lined up already.
function tableAlignmentChanges(text, { anchor, head }) {
  const aligned = alignTables(text);
  if (aligned === text) return null;

  const offsets = ({ from, to, text: insert }) => ({ from: offsetOf(text, from), to: offsetOf(text, to), insert });
  const { from, to, text: insert } = changedRange(text, aligned);
  const lines = changedLines(text, aligned)?.map(offsets);
  const moved = (offset) => offsetOf(aligned, movedCursor(positionOf(text, offset), text, aligned));

  return { changes: lines ?? [{ from, to, insert }], selection: { anchor: moved(anchor), head: moved(head) } };
}

// The |+ lines carrying on the table rows a deletion removes the whole of, each with its line break, so they go with
// their row rather than being left below the row above, which Raindown would read them as carrying on. As ranges in the
// text before the deletion, which is ranges too.
function orphanedRows(text, deletions) {
  const lines = text.split('\n');
  const starts = [0];
  lines.forEach((line) => starts.push(starts.at(-1) + line.length + 1));
  const removed = (number) => deletions.some(({ from, to }) => from <= starts[number] && starts[number] + lines[number].length <= to);

  return lines.flatMap((line, number) => {
    if (!line.trim() || !removed(number) || !/^[ \t]*\|/.test(line) || CONTINUATION.test(line)) return [];

    let last = number;
    while (CONTINUATION.test(lines[last + 1] ?? '')) last++;
    const rows = Array.from({ length: last - number }, (_, index) => number + 1 + index).filter((row) => !removed(row));
    return rows.map((row) => ({ from: starts[row], to: Math.min(starts[row + 1], text.length) }));
  });
}

// The editor extension deleting a table row's |+ lines with it, when its line's deleted, cut or selected and deleted.
function rowDeletions() {
  const { EditorState } = require('@codemirror/state');
  return EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || !(transaction.isUserEvent('delete') || transaction.isUserEvent('cut'))) return transaction;

    const deletions = [];
    transaction.changes.iterChanges((from, to) => { if (to > from) deletions.push({ from, to }); });
    const orphans = orphanedRows(transaction.startState.doc.toString(), deletions);
    return orphans.length ? [transaction, { changes: orphans }] : transaction;
  });
}

// The editor extension lining up a table in the same change as each key typed in it, so it's never out of line while
// Raindown writes back, and undo takes back both at once. Not while a letter's still being composed, as with an IME,
// or for spaces deleted, as deleting a formula cell's padding shows its formula, which Raindown can't tell if it's
// padded again. Raindown lines it up as it writes back.
function tableAlignment(plugin) {
  const { EditorState } = require('@codemirror/state');
  return EditorState.transactionFilter.of((transaction) => {
    const typed = transaction.isUserEvent('input') || transaction.isUserEvent('delete');
    if (!typed || transaction.isUserEvent('input.type.compose') || deletesOnlySpaces(transaction)) return transaction;
    if (!plugin.settings.writeBack || !transaction.docChanged) return transaction;

    const { main } = transaction.newSelection;
    if (!transaction.newDoc.lineAt(main.head).text.includes('|')) return transaction;

    const alignment = tableAlignmentChanges(transaction.newDoc.toString(), main);
    return alignment ? [transaction, { ...alignment, sequential: true }] : transaction;
  });
}

function deletesOnlySpaces(transaction) {
  let spaces = transaction.isUserEvent('delete');
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    spaces &&= !inserted.length && /^[ \t]+$/.test(transaction.startState.sliceDoc(fromA, toA));
  });
  return spaces;
}

// The line an error is on, from Raindown's messages like "<!-- toc: --> on line 7 needs <!-- :toc -->", or warnings
// like "line 7: toc: takes no value", or null.
function errorLine(message) {
  const line = /\b(?:on )?line (\d+)\b/.exec(message ?? '')?.[1];

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
      button.textContent = `Open ${this.data.split('.').at(-1).toUpperCase()}`;
      button.addEventListener('click', () => plugin.openTableFile(view.state.field(editorInfoField, false)?.file, this.data));
      return button;
    }
  }
  const marks = {
    error: Decoration.line({ class: 'cm-raindown-error' }),
    table: Decoration.line({ class: 'cm-raindown-table' })
  };
  const notSpellChecked = Decoration.mark({ attributes: { spellcheck: 'false' } });
  const errorFor = (view) => plugin.errors.get(view.state.field(editorInfoField, false)?.file?.path) ?? null;
  const decorate = (view) => {
    const builder = new RangeSetBuilder();
    const line = errorFor(view);
    const markdown = view.state.doc.toString();
    const options = { bare: plugin.settings.bareSyntax };
    // Phones and tablets have no app to open a table's file with.
    const buttons = !Platform.isDesktopApp ? [] : tableFiles(markdown, options).map(({ at, data }) => ({
      from: at, to: at, decoration: Decoration.widget({ widget: new OpenFileWidget(data), side: 1 })
    }));
    const tokens = directiveTokens(markdown, options);
    const unchecked = directiveLines(markdown, tokens).map((line) => ({ ...line, decoration: notSpellChecked }));
    const ranges = [...tokens, ...tableLines(markdown), ...buttons, ...unchecked];
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

// Carries a table's cell on onto a |+ row on Option or Alt and Enter, typed like any key, so the table's lined up.
function carryOnCell(view) {
  const change = carriedOnCell(view.state.doc.toString(), view.state.selection.main.head);
  if (!change) return false;

  view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert }, selection: { anchor: change.cursor }, userEvent: 'input' });
  return true;
}

// The editor extension for a held write-back: a hint at the end of the directive's line, Enter there to write back
// without a new line, and writing back once the cursor's left the line.
function heldWriteBacks(plugin) {
  const { Decoration, ViewPlugin, WidgetType, keymap } = require('@codemirror/view');
  const { Prec } = require('@codemirror/state');
  class HintWidget extends WidgetType {
    constructor(text) {
      super();
      this.text = text;
    }

    eq(other) {
      return other.text === this.text;
    }

    toDOM() {
      const hint = document.createElement('span');
      hint.className = 'cm-raindown-hint';
      hint.textContent = this.text;
      return hint;
    }
  }
  const hints = {
    held: Decoration.widget({ widget: new HintWidget('↵ Enter to update'), side: 1 }),
    collapse: Decoration.widget({ widget: new HintWidget('↵ Enter to collapse'), side: 1 }),
    expand: Decoration.widget({ widget: new HintWidget('↵ Enter to expand'), side: 1 })
  };
  const infoFor = (view) => view.state.field(editorInfoField, false);
  // The hint for a held write-back, or for what Enter does to a table: block's cell, only looked for on a table's lines.
  const decorate = (view) => {
    const info = infoFor(view);
    const { head } = view.state.selection.main;
    const line = view.state.doc.lineAt(head);
    if (!info?.file) return Decoration.none;
    if (plugin.held.has(info.file.path)) return Decoration.set([hints.held.range(line.to)]);
    if (!/^\s*[|+]/.test(line.text)) return Decoration.none;

    const toggle = cellToggleAt(view.state.doc.toString(), head, { bare: plugin.settings.bareSyntax });
    return toggle ? Decoration.set([hints[toggle].range(line.to)]) : Decoration.none;
  };

  return [
    ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = decorate(view); }
      update(update) {
        if (update.selectionSet) plugin.cursorMoved(infoFor(update.view));
        this.decorations = decorate(update.view);
      }
    }, { decorations: (instance) => instance.decorations }),
    Prec.high(keymap.of([
      { key: 'Enter', run: (view) => plugin.confirmHeld(infoFor(view)) || plugin.enterInTable(view, infoFor(view)) },
      { key: 'Alt-Enter', run: carryOnCell },
      { key: 'Tab', run: (view) => plugin.tabInTable(view, infoFor(view)) },
      { key: 'Shift-Tab', run: (view) => plugin.tabInTable(view, infoFor(view), { back: true }) },
      { key: 'Mod-s', run: (view) => plugin.writeBackOnSave(infoFor(view)) }
    ]))
  ];
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
    this.engine = new RaindownEngine(this.app);
    this.timers = new Map();
    // Each note being written back, and whether it's been asked to again.
    this.writing = new Map();
    // What each note was last written back as, so the save that writing it back makes doesn't start Raindown again.
    this.written = new Map();
    // Notes whose write-back waits for the cursor to leave a directive's line.
    this.held = new Set();
    // Each section's Markdown in reading view, by its note's path and Markdown.
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
    this.addCommand({
      id: 'open-table-file',
      name: "Open this table's file",
      editorCheckCallback: (checking, editor, view) => {
        const table = Platform.isDesktopApp && this.tableAtCursor(editor);
        if (table && !checking) this.openTableFile(view.file, table.data);
        return Boolean(table);
      }
    });
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      if (info.file && !this.inFixedCell(editor)) this.scheduleWriteBack(info.file, typingDelay(editor));
    }));
    // Obsidian's saves of what's typed in a fixed column aren't written back, as typing there isn't.
    this.registerEvent(this.app.vault.on('modify', (file) => {
      this.engine.fileChanged(file.path);
      const editor = this.editorFor(file);
      if (!editor || !this.inFixedCell(editor)) this.scheduleWriteBack(file);
    }));
    // The line of each note's error, for the editor to underline.
    this.errors = new Map();
    this.registerEditorExtension(highlighting(this));
    this.registerEditorExtension(heldWriteBacks(this));
    this.registerEditorExtension(tableAlignment(this));
    this.registerEditorExtension(rowDeletions());
    this.registerEditorSuggest(new DirectiveSuggest(this.app, this));
    this.registerMarkdownPostProcessor((el, context) => this.renderSection(el, context));
    // Obsidian adds every file as it loads, so lists are only written back for notes added after that, and Raindown has
    // the vault's files as it starts.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (file) => this.fileAdded(file)));
      this.registerEvent(this.app.vault.on('delete', (file) => this.fileRemoved(file, file.path)));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        this.fileRemoved(file, oldPath);
        this.fileAdded(file);
      }));
      // Started now, so the first write-back doesn't wait for Raindown to load.
      if (this.settings.writeBack) this.engine.start().catch((error) => this.report(error.message, { notify: false }));
    });
  }

  onunload() {
    this.timers.forEach((timer) => clearTimeout(timer));
    clearTimeout(this.listsTimer);
    this.engine.stop();
  }

  // A file or folder added to the vault, which Raindown's sent, with each file in it, and the lists it changes.
  fileAdded(file) {
    Vault.recurseChildren(file, (added) => this.engine.fileChanged(added.path));
    this.scheduleListsWriteBack(file);
  }

  fileRemoved(file, path) {
    this.engine.fileRemoved(path);
    this.scheduleListsWriteBack(file);
  }

  // Raindown's note as it writes it back, with its warnings, as { output, warnings }, with its endpoints run if execute.
  async raindown({ file, markdown, execute }) {
    const note = { path: file.path, markdown, bare: this.settings.bareSyntax };
    if (execute) note.execute = true;
    const answer = await this.engine.rewrite(note, { timeout: execute ? ENDPOINT_TIMEOUT : TIMEOUT });
    return { output: answer.output, warnings: (answer.warnings ?? []).join('\n') };
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
  // runs once more when it's done, with the note as it is by then, as it was last asked to, like forced by Enter.
  async writeBackInTurn(file, options = {}) {
    if (this.writing.has(file.path)) {
      this.writing.set(file.path, options);
      return;
    }

    this.writing.set(file.path, null);
    try {
      await this.writeBack(file, options);
    } finally {
      const again = this.writing.get(file.path);
      this.writing.delete(file.path);
      if (again) this.writeBackInTurn(file, again);
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

    try {
      const { output: markdown, warnings } = await this.raindown({ file, markdown: original, execute });
      // Raindown never empties a note, so nothing back, like from a wrapper script that failed, is an error.
      if (!markdown.trim() && original.trim()) throw new Error("Raindown didn't print the note back, so it's left as it is");
      if (markdown !== original) await this.applyToNote(file, original, markdown);

      this.written.set(file.path, markdown);
      this.showError(file, errorLine(warnings)); // A directive that couldn't run, like toc: extra, says its line.
      this.report(this.shortMessage(warnings, file), { notify, done: markdown === original ? 'Nothing to write back' : 'Written back' });
      return markdown !== original;
    } catch (error) {
      this.showError(file, errorLine(error.message));
      this.report(this.shortMessage(error.message, file), { notify });
      return false;
    }
  }

  // Reading view shows a section with <{ }> in it, like <{ :toc }>, as Raindown renders it, in Markdown, which Obsidian
  // renders, as Commonmarker can't run in the plugin.
  async renderSection(el, context) {
    const section = context.getSectionInfo(el);
    const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
    const lines = section?.text.split('\n').slice(section.lineStart, section.lineEnd + 1).join('\n');
    if (!lines?.includes('<{') || !file) return;

    try {
      const markdown = await this.sectionMarkdownFor(file, markSection(section.text, section.lineStart, section.lineEnd));
      if (markdown === null) return;

      el.replaceChildren();
      await MarkdownRenderer.render(this.app, markdown, el, file.path, this);
    } catch {
      // Reading view keeps what Obsidian rendered. Saving the note shows the error.
    }
  }

  // Reading view renders a section again each time it's shown, like switching to it, so its Markdown is kept until the
  // note changes, and a render that's under way is shared. Failed renders aren't kept.
  sectionMarkdownFor(file, markdown) {
    const key = `${file.path}\0${markdown}`;
    if (!this.sections.has(key)) {
      const note = { path: file.path, markdown, bare: this.settings.bareSyntax };
      const rendered = this.engine.render(note, { timeout: TIMEOUT }).then(({ output }) => sectionMarkdown(output));
      rendered.catch(() => this.sections.delete(key));
      this.sections.set(key, rendered);
      if (this.sections.size > SECTIONS_KEPT) this.sections.delete(this.sections.keys().next().value);
    }

    return this.sections.get(key);
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
  // Enter in a table's row writes back, saving the cell left to its table's file and clipping it, as typing in a fixed
  // column doesn't, like a spreadsheet's cell is saved when it's done with.
  enterInTable(view, info) {
    const change = enteredCell(view.state.doc.toString(), view.state.selection.main.head, { bare: this.settings.bareSyntax });
    if (!change) return false;

    view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert }, selection: { anchor: change.cursor }, userEvent: 'input' });
    if (info?.file) this.writeBackInTurn(info.file, { force: true });
    return true;
  }

  // Tab in a table's row moves to the next cell, or back, and writes back, saving the cell left, like Enter.
  tabInTable(view, info, options) {
    const cursor = tabbedCell(view.state.doc.toString(), view.state.selection.main.head, options);
    if (cursor === null) return false;

    view.dispatch({ selection: { anchor: cursor } });
    if (info?.file) this.writeBackInTurn(info.file);
    return true;
  }

  // Saving writes back too, saving a fixed column's cell just typed into, then leaves Obsidian to save.
  writeBackOnSave(info) {
    if (info?.file) this.writeBackInTurn(info.file, { force: true });
    return false;
  }

  // Whether the cursor's in a table: block's fixed column, where typing isn't written back, as Raindown would clip what's
  // being typed, until Enter or saving.
  inFixedCell(editor) {
    return inFixedCell(editor.getValue(), editor.getCursor(), { bare: this.settings.bareSyntax });
  }

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
    const nodes = vaultPath(await this.projectRoot(file), '.raindown');
    if (!await this.app.vault.adapter.exists(nodes)) return [];

    const { files } = await this.app.vault.adapter.list(nodes);
    return files.map((file) => /\/([A-Z]\w*)\.(?:rb|js|mjs|md|rd)$/.exec(file)?.[1]).filter(Boolean);
  }

  // The folder Raindown reads a note's files from, like a table's: the nearest with a .raindown folder, or the vault.
  async projectRoot(file) {
    for (let folder = vaultPath(file?.parent?.path ?? ''); ; folder = vaultPath(folder, '..')) {
      if (await this.app.vault.adapter.exists(vaultPath(folder, '.raindown'))) return folder;
      if (folder === '') return '';
    }
  }

  // Opens a table's file in the app the computer opens it with, like Numbers or Excel, as Obsidian doesn't open CSV
  // files. Editing it there changes the table in the note too.
  async openTableFile(file, data) {
    const found = vaultPath(await this.projectRoot(file), data);
    if (found.startsWith('..')) return new Notice(`${data} isn't in the vault`);
    if (!await this.app.vault.adapter.exists(found)) return new Notice(`${data} is made when the note's written back`);
    return this.app.openWithDefaultApp(found);
  }

  // The table: directive at the cursor, or the nearest above it.
  tableAtCursor(editor) {
    const { line } = editor.getCursor();
    const cursorLineEnd = editor.posToOffset({ line, ch: editor.getLine(line).length });
    return tableFiles(editor.getValue(), { bare: this.settings.bareSyntax }).filter(({ at }) => at <= cursorLineEnd).at(-1);
  }

  // An open note's changed in its editor, as typing it would be, which Obsidian then saves, rather than on disk under
  // it, which Obsidian reports as modified externally. Others are changed through the vault.
  async applyToNote(file, original, markdown) {
    const editor = this.editorFor(file);
    if (!editor) return this.app.vault.process(file, (current) => applyRewrite(current, original, markdown));
    const current = editor.getValue();
    if (current !== original) {
      const comments = blockCommentChanges(current, markdown);
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

  // Raindown's message, which names files by their path in Ruby, like /vault/notes/a.md, without the note's own, as it's
  // the one it's about, others' from the vault's, or Raindown's name, as the status has it.
  shortMessage(message, file) {
    return message.replace(/^raindown: /gm, '').replaceAll(`/vault/${file.path}: `, '').replaceAll('/vault/', '');
  }
  
  report(message, { notify, done }) {
    this.status.setText(message ? `Raindown: ${message.split('\n')[0]}` : '');
    if (notify) new Notice(message || done);
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

    this.addToggle('writeBack', 'Write-back', 'Write back to a note with directives as you type');
    this.addToggle('bareSyntax', 'Bare syntax', 'Recognise bare directives like "toc:" (equivalent to CLI --bare)', BARE_SYNTAX_WARNING);
  }

  // A warning, if it has one, goes below its description, after a blank line, in the theme's warning colour.
  addToggle(key, name, description, warning) {
    const text = createFragment((fragment) => {
      fragment.appendText(description);
      if (warning) fragment.createDiv({ cls: 'mod-warning raindown-setting-warning', text: warning });
    });
    new Setting(this.containerEl).setName(name).setDesc(text)
      .addToggle((toggle) => toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}

module.exports = RaindownPlugin;
Object.assign(module.exports, {
  alignTables, applyRewrite, blockCommentChanges, carriedOnCell, cellToggleAt, changedLines, changedRange, changeOutsideHistory,
  directiveLines, DirectiveSuggest, directiveTokens, enteredCell, errorLine, hasDirectives, inFixedCell, inFormulaCell,
  movedCursor, onDirectiveLine, orphanedRows, rowDeletions, tabbedCell, tableAlignment, tableAlignmentChanges, tableFiles,
  tableLines, markSection, sectionMarkdown, vaultPath
});
