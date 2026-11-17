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

- A component's bare directive, like `BookCard: title: Dune`, works in every note, without the Bare syntax setting, and is highlighted, as Raindown's own, like `toc:`, still need it
- Raindown runs inside the plugin, so there's nothing else to install
- Components is smaller, under 5 MB rather than 5.8, packing only the Ruby it runs, rather than all of Raindown's, with Raindown's next release
- Endpoints are sent by Obsidian, rather than curl
- JavaScript components run inside the plugin, rather than Node.js
- Raindown starts in about half the time, and the plugin's about 10 MB, with Ruby for engines with JSPI and for those without
- `<{ }>` in reading view is rendered by Obsidian, from Raindown's Markdown
- Typing in a `table:` table's fixed column saves on Enter, Tab or Cmd+S, not as you type
- A note's JavaScript components are asked for what they write together, and one that can't be loaded leaves the others working, with Raindown v0.21.0
- Raindown runs on Ruby 4.0, in place of 3.4
- Raindown loads in two thirds of the time, and writes back a note of components up to twice as fast, as its Ruby's patched to catch exceptions, `break` and `ensure` without unwinding its whole stack in WebAssembly
- A vault's Ruby nodes run faster: iterating a hash, `Mutex#synchronize`, `catch`, `require`, comparing arrays and reading the vault's files are 3 to 13 times faster
- Ruby starts about 150 ms sooner, as its shape tree's 280 MB is no longer allocated and zeroed as it starts
- Ruby runs 1.5 to 2 times as fast where Obsidian has JSPI, as on desktop, as it's built without Asyncify there, and starts in three quarters of the time
- Raindown starts about a quarter sooner in a vault of thousands of notes, as it reads the vault while Ruby starts
- Notes write back sooner in big vaults, as only the files Raindown wrote are checked after each
- Notes of components write back in about half the time, and JavaScript components in big vaults many times faster, with Raindown v0.23.0
- On desktop, notes write back 15 to 25% faster, and Raindown starts sooner, as Ruby collects its garbage between notes, and starts again when it's idle if a heavy note's left it using more than 512 MB

### Removed

- The Raindown command setting, and Find Raindown

### Fixed

- Markdown Components write back, rather than failing to load Commonmarker, which the plugin hasn't got, with Raindown's next release

- Deleting a row deletes its `|+` rows too
- Enter on a table's delimiter row no longer splits the table
- A Ruby node that rescues an exception, breaks out of a block or throws thousands of times no longer slows to a stop, or fails with `stack level too deep`
