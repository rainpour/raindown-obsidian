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
}

class Notice {
  static messages = [];

  constructor(message) { Notice.messages.push(message); }
}

class FileSystemAdapter {
  constructor(basePath) { this.basePath = basePath; }
  getBasePath() { return this.basePath; }
}

class PluginSettingTab {}
class Setting {}

module.exports = { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting };
