# Components

Reusable templates for your notes that stay up to date. Write a component once in Markdown, give it different arguments in each note and edit it to update every note that uses it.

## Define a component

Run **New component** from the command palette. It makes a note in a `Components` folder, which you rename to what it's for, like `BookCard`. A component's name starts with a capital letter and has no spaces.

Write the component as a note with default values in front matter:

```md
---
rating: 0
---

**{title}** · {rating}/5
```

Variables are a lowercase/snake case word surrounded by braces `{}`.

## Use a component

In any note write the component's name followed by a `:` then any arguments like so:

```md
BookCard: title: Dune rating: 5
```

The component will produce output beneath based on the template you defined:

```md
BookCard: title: Dune rating: 5
**Dune** · 5/5
```

Change a value and output is updated. Edit the `BookCard` component/template definition and every note that uses it is updated.

## Multi-line output

If your template contains any empty lines, for example...
```
**{title}**
            <-- Empty space here.
{rating}/5
```

...then the component needs to be used with HTML comment syntax so that the component can tell where its output starts and ends. So that multi-line output becomes:

```md
<!-- BookCard: title: Dune rating: 5 -->
**Dune**

5/5
<!-- :BookCard -->
```

## Why Components

- **It's plain Markdown.** What a component writes is in your note, so it reads the same on your phone, in other apps, on GitHub and in search, even without Components
- **No code.** A component is a note
- **One place to change.** Edit a component once and every note that uses it updates

## Advanced Usage

Components is part of [Raindown](https://raindown.dev), which outputs tables, tables of contents, lists and charts into your notes too, and runs components written in JavaScript or Ruby. **Raindown** does everything Components does and more, so Components turns itself off when Raindown's enabled.

## Source

Components is built from the same source as Raindown's Obsidian plugin, in [rainpour/raindown-obsidian](https://github.com/rainpour/raindown-obsidian), where it's changed, this README included, in `components/repository`. This repository is filled in from there: its files as they change, and the plugin's source with each release, which [DEVELOPMENT.md](DEVELOPMENT.md) says how to build.
