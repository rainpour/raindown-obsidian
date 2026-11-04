# Raindown for Obsidian

Writes back to your notes as you save them, like `raindown watch`: tables of contents, file lists, [components](https://raindown.dev/docs/components) and charts. Unlike a query plugin, what it writes is plain Markdown in the note, so it reads the same on GitHub, on your phone and in any other editor.

```md
<!-- files: folder: 'journal' -->
- [Today](<journal/Today.md>)
<!-- :files -->
```

## How it works

Once you stop typing, the plugin gives the note to Raindown's [editor server](https://raindown.dev/docs/cli#editor-server), `raindown server`, which answers with the note as Raindown would write it back. It keeps Raindown loaded, so after the first, which takes about a second, each takes a few milliseconds. With a Raindown from before it, the plugin runs `raindown NOTE --stdin --rewrite` each time instead. The plugin applies that through Obsidian, and only if the note hasn't changed since, so nothing you type is lost. Notes without directives, like `<!-- toc: -->`, or `raindown: true` in their front matter, don't start Raindown.

A bare directive, on its own line like `toc:`, only writes back in a note with `raindown: true` in its front matter, unless **Bare directives in every note** is on. Only names Raindown knows, like `toc:`, `files:` and your project's nodes, write anything, so a line like `Summary:` is left alone, but a line like `files:` that's only text gets a file list.

Adding, renaming or removing a note writes back the notes with lists, like `files:` and `list:`, so they don't go stale.

## In the editor

- **Highlighting**, like in the VS Code extension: directives in comments, with their end tags, in `<{ }>`, and bare where they'd write back.
- **Completion** of directive names after `<!--` or `<{`, or at the start of a line where bare directives write back, from Raindown's own, like `toc:` and `files:`, and your project's nodes in `.raindown/`.
- **Errors**, like a directive that's half typed, show in the status bar, and the line they're on is underlined, when Raindown says which it is.
- **Reading view** shows `<{ }>` directives, like `<{ :toc }>`, as Raindown renders them, which only Raindown can. Each section's kept until the note changes, so switching views doesn't render it again. Wikilinks are Obsidian's own, so Obsidian renders the rest of the note as usual.

## Commands

| Command                                      | Does                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Raindown: Write back this note**           | Writes back now, and says what happened                                                 |
| **Raindown: Run the endpoints in this note** | Runs the [endpoints](https://raindown.dev/docs/endpoints) without a response, like `-x` |
| **Raindown: Write back all notes**           | Writes back every note with directives, and says how many changed                       |
| **Raindown: Download Raindown**              | Downloads the latest standalone binary, or updates it now                               |

Endpoints never run on save, only from the command.

## Requirements

The `raindown` executable. The first time the plugin can't find it, it looks on your shell's `PATH`, which Obsidian opened from the Dock doesn't have, and if it's not there either, offers to download the [standalone binary](https://raindown.dev/docs/getting-started#installation) from GitHub, checked against the release's checksums, to `~/.local/bin/raindown`, or `%LOCALAPPDATA%\Programs\raindown` on Windows, outside your vault so it isn't synced. It's only downloaded if you say so. Once a day at most, a binary it downloaded is checked against the latest release, and it asks before updating it. Turning an update down skips that release.

It can also come from `gem install raindown`, or set the plugin's **Raindown command** to its full path. It's desktop only, as Obsidian on phones can't run Raindown.

## Settings

| Setting                           | Default    | Description                                                                          |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| **Raindown command**              | `raindown` | The raindown executable, or its full path                                            |
| **Write back on save**            | On         | Write back to a note with directives once you stop typing                            |
| **Bare directives in every note** | Off        | Directives on their own line, like `toc:`, in every note, as with `--bare` |

## Install

The plugin isn't in Obsidian's community plugins yet. Copy `main.js`, `manifest.json` and `styles.css` into your vault's `.obsidian/plugins/raindown/` folder, then turn on **Raindown** in **Settings → Community plugins**.

## Development

The plugin is plain JavaScript with no dependencies or build step, like the VS Code extension. Its tests run outside Obsidian, with a stub of Obsidian's API:

```sh
npm test
```

To link it into a vault while you work on it, `ln -s "$PWD" VAULT/.obsidian/plugins/raindown`, then reload Obsidian after a change.

### Releasing

Obsidian installs a plugin from its GitHub repo's releases, so the plugin is released from a repo of its own, with this folder as its root. `npm version minor`, or `patch`, sets the version in `package.json` and `manifest.json`, adds it to `versions.json` with the oldest Obsidian it runs on, and tags it without a `v`, like `0.2.0`, as Obsidian needs. Pushing the tag runs the tests and attaches `main.js`, `manifest.json` and `styles.css` to a release:

```sh
npm version minor
git push --follow-tags
```
