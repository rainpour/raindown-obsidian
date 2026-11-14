# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Tables line up as you type
- Fixed-width columns, like `| ==== |`, and `|+` rows line up too
- Tab and Shift+Tab move between a table's cells
- Enter moves to the next row, adding one below the last
- Enter expands a clipped cell, and collapses an expanded one
- Option+Enter, or Alt+Enter, breaks a cell onto a `|+` row
- Table headers are bold, delimiter rows muted and pipes faint
- `|+` rows show in the accent colour
- Tables don't wrap, so wide ones scroll sideways
- Phones and tablets, as Raindown runs inside the plugin
- Raindown's services for the vault's Ruby and JavaScript nodes: the vault's files, fetch through Obsidian and a cache

### Changed

- Raindown runs inside the plugin, so there's nothing else to install
- Endpoints are sent by Obsidian, rather than curl
- JavaScript components run inside the plugin, rather than Node.js
- The plugin is less than half the size, about 4 MB, and Raindown starts in about half the time
- `<{ }>` in reading view is rendered by Obsidian, from Raindown's Markdown
- Typing in a `table:` table's fixed column saves on Enter, Tab or Cmd+S, not as you type
- A note's JavaScript components are asked for what they write together, and one that can't be loaded leaves the others working, with Raindown v0.21.0

### Removed

- The Raindown command setting, and Find Raindown

### Fixed

- Deleting a row deletes its `|+` rows too
- Enter on a table's delimiter row no longer splits the table
