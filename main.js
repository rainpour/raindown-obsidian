'use strict';

// Raindown for Obsidian: as a note's saved, Raindown writes back to it, like `raindown watch`, filling in its tables of
// contents, file lists, backlinks, components and charts. Obsidian loads this one file, so it has no build step.
const childProcess = require('child_process');
const os = require('os');
const path = require('path');
const { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = { command: 'raindown', writeBackOnSave: true };
// Obsidian saves as you type, so a note's written back once its saves pause.
const DELAY = 1000;
const TIMEOUT = 10000;
const ENDPOINT_TIMEOUT = 60000;
const MAX_BUFFER = 32 * 1024 * 1024;
// A content directive in a comment, like <!-- toc: --> or <!-- Changelog: -->, or front matter allowing bare ones.
// Saves of notes without them don't start Raindown.
const DIRECTIVE = /<!--\s*[A-Za-z][\w:]*:|^raindown:\s*true\s*$/m;

function hasDirectives(markdown) {
  return DIRECTIVE.test(markdown);
}

// "raindown NOTE --stdin --rewrite" prints the Markdown it's given as it would write it back to NOTE, without writing
// NOTE, so Obsidian applies it to the note it's editing. With -x, endpoints without a response run too.
function rewriteArgs(filePath, { execute = false } = {}) {
  return [filePath, '--stdin', '--rewrite', ...(execute ? ['-x'] : [])];
}

// What Raindown wrote back is only applied to the note it was given, so typing since then is never lost.
function applyRewrite(current, original, rewritten) {
  if (current !== original) return current;

  return rewritten;
}

// The command as it's set, with ~ for the home folder, which only a shell would expand.
function expandCommand(command) {
  return command.replace(/^~(?=\/|$)/, os.homedir());
}

function errorMessage(error, stderr, command) {
  if (error.code === 'ENOENT') {
    return `Couldn't run "${command}". Install Raindown, or set its full path in the plugin's settings, ` +
      "since Obsidian doesn't always see your shell's PATH.";
  }

  return (stderr && stderr.trim()) || error.message;
}

// Resolves with the rewritten Markdown and Raindown's warnings, like failed endpoint checks.
function runRaindown(command, args, input, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    const options = { cwd, timeout, maxBuffer: MAX_BUFFER };
    const child = childProcess.execFile(expandCommand(command), args, options, (error, stdout, stderr) => {
      if (error) reject(new Error(errorMessage(error, stderr, command)));
      else resolve({ markdown: stdout, warnings: stderr.trim() });
    });

    child.stdin.on('error', () => {}); // The exit callback reports why Raindown stopped reading.
    child.stdin.end(input);
  });
}

class RaindownPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.timers = new Map();
    // What each note was last written back as, so the save that writing it back makes doesn't start Raindown again.
    this.written = new Map();
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
    this.registerEvent(this.app.vault.on('modify', (file) => this.scheduleWriteBack(file)));
  }

  onunload() {
    this.timers.forEach((timer) => clearTimeout(timer));
  }

  withActiveNote(checking, action) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return false;
    if (!checking) action(file);

    return true;
  }

  scheduleWriteBack(file) {
    if (!this.settings.writeBackOnSave || file.extension !== 'md') return;

    clearTimeout(this.timers.get(file.path));
    this.timers.set(file.path, setTimeout(() => {
      this.timers.delete(file.path);
      this.writeBack(file);
    }, DELAY));
  }

  // Saving writes back quietly, showing errors in the status bar, as a directive that's half typed fails until it's
  // done. The commands say what happened.
  async writeBack(file, { execute = false, notify = false } = {}) {
    const original = await this.app.vault.read(file);
    if (!notify && (this.written.get(file.path) === original || !hasDirectives(original))) return;

    const filePath = this.absolutePath(file);
    const timeout = execute ? ENDPOINT_TIMEOUT : TIMEOUT;

    try {
      const args = rewriteArgs(filePath, { execute });
      const { markdown, warnings } = await runRaindown(this.settings.command, args, original, { cwd: path.dirname(filePath), timeout });
      // Raindown never empties a note, so nothing back, like from a wrapper script that failed, is an error.
      if (!markdown.trim() && original.trim()) throw new Error("Raindown didn't print the note back, so it's left as it is");
      if (markdown !== original) await this.app.vault.process(file, (current) => applyRewrite(current, original, markdown));

      this.written.set(file.path, markdown);
      this.report(warnings, { notify, done: markdown === original ? 'Nothing to write back' : 'Written back' });
    } catch (error) {
      this.report(error.message, { notify });
    }
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
      .setDesc('The raindown gem or a standalone binary. Use its full path, like ~/.local/bin/raindown, ' +
        "if Obsidian can't find it.")
      .addText((text) => text.setPlaceholder('raindown').setValue(this.plugin.settings.command).onChange(async (value) => {
        this.plugin.settings.command = value.trim() || DEFAULT_SETTINGS.command;
        await this.plugin.saveData(this.plugin.settings);
      }));

    new Setting(containerEl)
      .setName('Write back on save')
      .setDesc("Write back to a note with directives once you stop typing. Endpoints only run from the command.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.writeBackOnSave).onChange(async (value) => {
        this.plugin.settings.writeBackOnSave = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}

module.exports = RaindownPlugin;
Object.assign(module.exports, { applyRewrite, errorMessage, expandCommand, hasDirectives, rewriteArgs, runRaindown });
