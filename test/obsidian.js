'use strict';

// Just enough of Obsidian's API for the plugin to load and run outside Obsidian.
class Plugin {
  constructor(app) {
    this.app = app;
    this.commands = [];
  }

  async loadData() { return null; }
  async saveData() {}
  addStatusBarItem() { return { text: '', setText(text) { this.text = text; } }; }
  addSettingTab() {}
  addCommand(command) { this.commands.push(command); }
  registerEvent() {}
  registerEditorExtension() {}
  registerEditorSuggest() {}
  registerMarkdownPostProcessor(processor) { this.postProcessor = processor; }
}

class Notice {
  static messages = [];

  constructor(message) { Notice.messages.push(message); }
}

class EditorSuggest {
  constructor(app) { this.app = app; }
}

class PluginSettingTab {}

class Vault {
  static recurseChildren(file, callback) {
    callback(file);
    file.children?.forEach((child) => Vault.recurseChildren(child, callback));
  }
}

class Setting {}

const editorInfoField = {};

const Platform = { isDesktopApp: true };

const MarkdownRenderer = {
  rendered: [],
  async render(_app, markdown, el, sourcePath) {
    MarkdownRenderer.rendered.push({ markdown, sourcePath });
    el.replaceChildren(markdown);
  }
};

module.exports = { EditorSuggest, MarkdownRenderer, Notice, Platform, Plugin, PluginSettingTab, Setting, Vault, editorInfoField };
