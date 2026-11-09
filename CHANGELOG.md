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

### Changed

- Needs Raindown 0.18.0 or newer
- Typing in a `table:` table's fixed column saves on Enter, Tab or Cmd+S, not as you type

### Fixed

- Deleting a row deletes its `|+` rows too
- Enter on a table's delimiter row no longer splits the table
