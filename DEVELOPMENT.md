# Development

## Architecture

Once you stop typing, the plugin gives the note to Raindown's [editor server](https://raindown.dev/docs/cli#editor-server), `raindown server`, which answers with the note as Raindown would write it back. It keeps Raindown loaded, so after the first, which takes about a second, each takes a few milliseconds. With a Raindown from before it, the plugin runs `raindown NOTE --stdin --rewrite` each time instead. The plugin applies that through Obsidian, and only if the note hasn't changed since, so nothing you type is lost. A `raindown` watching a folder above the vault, like `~/dev`, leaves it alone, so the two never both write to a note. Notes without directives, like `<!-- toc: -->`, or `raindown: true` in their front matter, don't start Raindown.

## Testing

The plugin is plain JavaScript with no dependencies or build step, like the VS Code extension. Its tests run outside Obsidian, with a stub of Obsidian's API:

```sh
npm test
```

To link it into a vault while you work on it, `ln -s "$PWD" VAULT/.obsidian/plugins/raindown`, then reload Obsidian after a change.

### Releasing

Obsidian installs a plugin from its GitHub repo's releases, so the plugin is released from a repo of its own, with this folder as its root. `bin/bump` runs `npm version patch`, or `minor` or `major`, which sets the version in `package.json` and `manifest.json`, adds it to `versions.json` with the oldest Obsidian it runs on, and tags it without a `v`, like `0.2.0`, as Obsidian needs, then pushes it, which runs the tests and attaches `main.js`, `manifest.json` and `styles.css` to a release:

```sh
bin/bump # patch
bin/bump minor
```
