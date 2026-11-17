'use strict';

// Which plugin this is, as both are built from here: Raindown, with all of it, or Components, for beginners, which
// "bin/build --components" builds, with only Markdown Components, in a vault's Components folder, which Obsidian shows,
// and none of Raindown's own nodes, endpoints or table editing. Raindown has the same editions, which the worker tells
// it.
// Each has its folder of components, which files in it are components, by name, and Raindown's own directives, to
// suggest.
const EDITIONS = {
  full: {
    name: 'full', title: 'Raindown', folder: '.raindown', components: /\/([A-Z]\w*)\.(?:rb|js|mjs|md|rd)$/, full: true,
    directives: ['chart', 'endpoint', 'for', 'if', 'list', 'schema', 'table', 'toc']
  },
  components: {
    name: 'components', title: 'Components', folder: 'Components', components: /\/([A-Z]\w*)\.md$/, full: false, directives: []
  }
};
// The one this is, which bin/build names.
const BUILT = 'full';

module.exports = EDITIONS[BUILT];
