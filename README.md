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
| **Write-back**       | On         | Write back to a note with directives as you type                                     |
| **Bare syntax**      | Off        | Recognise bare directives on their own line like `toc:` (equivalent to CLI `--bare`) |

A bare directive, on its own line like `toc:`, only writes back in a note with `raindown: true` in its front matter, unless **Bare syntax** is on. Only names Raindown knows like `toc:`, `list:` and your project's nodes write anything, so a line like `Summary:` is left alone.

Adding, renaming or removing a note writes back the notes with lists, like `list:`, so they don't go stale.

## Commands

| Command                                      | Does                                                                |
| -------------------------------------------- | ------------------------------------------------------------------- |
| **Raindown: Write back this note**           | Writes back now, and says what happened                             |
| **Raindown: Run the endpoints in this note** | Runs the [endpoints](/docs/endpoints) without a response, like `-x` |
| **Raindown: Write back all notes**           | Writes back every note with directives, and says how many changed   |
| **Raindown: Find Raindown**                  | Looks for Raindown again, once you've installed it                  |

> [!NOTE]
> Unlike the [CLI](/docs/cli) endpoints in Obsidian never run on save, only via the command.

## Requirements

The `raindown` executable, which you [install yourself](https://raindown.dev/docs/install) by pasting one command into a terminal, or with `gem install raindown`. Running that command again updates it. The plugin never installs or updates it, as Obsidian's developer policies don't allow that.

The first time the plugin can't find it, it looks in `~/.local/bin`, or `%LOCALAPPDATA%\Programs\raindown` on Windows, and on your shell's `PATH`, which Obsidian opened from the Dock doesn't have. If it's not there either, it shows the command to run, and **Check again** or **Raindown: Find Raindown** looks again once you have. You can also set the plugin's **Raindown command** to its full path.

It's desktop only, as Obsidian on phones can't run Raindown.

## Files and network

- **Running Raindown** - Raindown is a separate program, so the plugin runs it to write back to your notes, and starts your shell once to find it on your `PATH`. Like any program you run, Raindown isn't limited to your vault, but the plugin only gives it file paths inside your vault.
- **Network** - The plugin doesn't use the network itself. Raindown calls the URLs in a note's endpoints when you run **Raindown: Run the endpoints in this note**, and your vault's own nodes in `.raindown` are code that can use it too.
