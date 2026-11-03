# Raindown for Obsidian

Writes back to your notes as you save them, like `raindown watch`: tables of contents, file lists, [backlinks](https://raindown.dev/docs/metadata#wikilinks-and-backlinks), [components](https://raindown.dev/docs/components) and charts. Unlike a query plugin, what it writes is plain Markdown in the note, so it reads the same on GitHub, on your phone and in any other editor.

```md
<!-- backlinks: -->
- [Today](<journal/Today.md>)
<!-- :backlinks -->
```

## How it works

Once you stop typing, the plugin gives the note to `raindown NOTE --stdin --rewrite`, which prints the note as Raindown would write it back. The plugin applies that through Obsidian, and only if the note hasn't changed since, so nothing you type is lost. Notes without directives, like `<!-- toc: -->`, or `raindown: true` in their front matter, don't start Raindown.

Errors, like a directive that's half typed, show in the status bar. Wikilinks are Obsidian's own, so Obsidian renders the note as usual.

## Commands

| Command                                      | Does                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Raindown: Write back this note**           | Writes back now, and says what happened                                                 |
| **Raindown: Run the endpoints in this note** | Runs the [endpoints](https://raindown.dev/docs/endpoints) without a response, like `-x` |

Endpoints never run on save, only from the command.

## Requirements

The `raindown` executable, from the [standalone binary](https://raindown.dev/docs/getting-started#installation) or via `gem install raindown`. Obsidian often doesn't see your shell's `PATH`, so set the plugin's **Raindown command** to its full path, like `~/.local/bin/raindown`, if Obsidian can't find it. It's desktop only, as Obsidian on phones can't run Raindown.

## Settings

| Setting                | Default    | Description                                               |
| ---------------------- | ---------- | --------------------------------------------------------- |
| **Raindown command**   | `raindown` | The raindown executable, or its full path                 |
| **Write back on save** | On         | Write back to a note with directives once you stop typing |

## Install

The plugin isn't in Obsidian's community plugins yet. Copy `main.js` and `manifest.json` into your vault's `.obsidian/plugins/raindown/` folder, then turn on **Raindown** in **Settings → Community plugins**.

## Development

The plugin is plain JavaScript with no dependencies or build step, like the VS Code extension. Its tests run outside Obsidian, with a stub of Obsidian's API:

```sh
node --test test/*.test.js
```
