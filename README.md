# Raindown for Obsidian

A Markdown-superset tailored for Obsidian with some additional features:

## Features

### Metadata

Underscored values in file paths are automatically converted to metadata. For example, in the following file path...
```
docs/_basics/_1-getting-started.md
```

...the `_basics` and `_1` produce metadata that is equivalent to the following front matter:
```markdown
---
folder: basics
order: 1
---
```

> [!TIP]
> Separate multiple folder tags with `&`:
> `docs/_1&_basics/_1-getting-started.md`

### List

[`list:`](/docs/list) writes a link to each note with a tag or in a folder, like `list: tags: 'book'`

````md
list: tags: 'book'
- [Dune](books/Dune.md)
- [Hyperion](books/Hyperion.md)
````

### Table

[`table:`](/docs/table) writes a CSV or TSV file in your vault into the note as a table. Edit a cell in the note and it's written back to the file, and changing the file updates the table.

````md
table: 'data/books.csv'
<!-- table 2 rows · f690ac -->
| title    | rating |
| -------- | ------ |
| Dune     | 5      |
| Hyperion | 4      |
````

### Charts

[`chart:`](/docs/chart) draws a CSV, TSV, JSON or YAML file in your vault.

````md
chart: 'data/reading.csv'
```
Jan  ███████████████████████▊                 320
Feb  ████████████████████████████████████████ 540
Mar  ██████████████████████████████▍          410
```
````

### Table of contents

[`toc:`](/docs/toc) writes an inline TOC which updates as you add and rename headings.

````md
# Books

toc:
- [Reading](#reading)
- [Finished](#finished)

## Reading

## Finished
````

### Components

A note in your vault's `.raindown` folder, like `BookCard.md`, is a [component](/docs/components#markdown) with no code, a template whose properties fill its `{variables}`, like `BookCard: title: Dune rating: 5`.

## Install

The plugin isn't in Obsidian's community plugins yet. Copy `main.js`, `manifest.json` and `styles.css` from the [source](https://github.com/rainpour/raindown-obsidian) into your vault's `.obsidian/plugins/raindown/` folder, then turn on **Raindown** in **Settings → Community plugins**.

## Settings

| Setting              | Default    | Description                                                                          |
| -------------------- | ---------- | ------------------------------------------------------------------------------------ |
| **Raindown command** | `raindown` | The raindown executable, or its full path                                            |
| **Write-back**       | On         | Write back to a note with directives once you stop typing                            |
| **Bare syntax**      | Off        | Recognise bare directives on their own line like `toc:` (equivalent to CLI `--bare`) |

A bare directive, on its own line like `toc:`, only writes back in a note with `raindown: true` in its front matter, unless **Bare syntax** is on. Only names Raindown knows like `toc:`, `list:` and your project's nodes write anything, so a line like `Summary:` is left alone.

Adding, renaming or removing a note writes back the notes with lists, like `list:`, so they don't go stale.

## Commands

| Command                                      | Does                                                                |
| -------------------------------------------- | ------------------------------------------------------------------- |
| **Raindown: Write back this note**           | Writes back now, and says what happened                             |
| **Raindown: Run the endpoints in this note** | Runs the [endpoints](/docs/endpoints) without a response, like `-x` |
| **Raindown: Write back all notes**           | Writes back every note with directives, and says how many changed   |
| **Raindown: Download Raindown**              | Downloads the latest standalone binary, or updates it now           |

> [!NOTE]
> Unlike the [CLI](/docs/cli) endpoints in Obsidian never run on save, only via the command.

## Requirements

The `raindown` executable. The first time the plugin can't find it, it looks on your shell's `PATH`, which Obsidian opened from the Dock doesn't have, and if it's not there either, offers to download the [standalone binary](https://raindown.dev/docs/getting-started#installation) from GitHub, checked against the release's checksums, to `~/.local/bin/raindown`, or `%LOCALAPPDATA%\Programs\raindown` on Windows, outside your vault so it isn't synced. It's only downloaded if you say so. Once a day at most, a binary it downloaded is checked against the latest release, and it asks before updating it. Turning an update down skips that release.

It can also come from `gem install raindown`, or set the plugin's **Raindown command** to its full path. It's desktop only, as Obsidian on phones can't run Raindown.

## Files and network

The plugin goes outside your vault for these reasons:

- **Saving the binary** - It uses Node's `fs` module to save the standalone binary outside your vault, as Obsidian's vault API can only write inside it, and a binary in your vault would be synced to your other devices. It only checks that `raindown` exists and writes it, and only writes it if you agree to the download or an update.
- **Running Raindown** - Raindown is a separate program, so the plugin runs it to write back to your notes. Like any program you run, it isn't limited to your vault. However the plugin only requests to process file paths inside your vault.

It uses the network for these reasons:

- **GitHub** - It downloads the binary and its checksums from Raindown's releases if you agree, and checks for a new release once a day at most if it downloaded the binary.
- **Endpoints** - Raindown calls the URLs in a note's endpoints when you run **Raindown: Run the endpoints in this note**.
