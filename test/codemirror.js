'use strict';

// Just enough of the CodeMirror Obsidian gives plugins for the editor extension to be made outside Obsidian.
module.exports = {
  Decoration: { mark: (spec) => spec, line: (spec) => spec },
  ViewPlugin: { fromClass: (cls, spec) => ({ cls, spec }) },
  WidgetType: class {},
  RangeSetBuilder: class {},
  Transaction: { addToHistory: { of: (value) => ({ addToHistory: value }) } }
};
