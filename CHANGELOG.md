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

### Changed

- Raindown runs inside the plugin, so there's nothing else to install
- Typing in a `table:` table's fixed column saves on Enter, Tab or Cmd+S, not as you type

### Removed

- Running endpoints, for now
- JavaScript components, for now
- `<{ }>` in reading view, for now
- The Raindown command setting, and Find Raindown

### Fixed

- Deleting a row deletes its `|+` rows too
- Enter on a table's delimiter row no longer splits the table
