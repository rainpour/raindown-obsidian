# frozen_string_literal: true

require 'json'
require 'raindown/editing'

# What the plugin's worker asks of Raindown, running in Ruby compiled to WebAssembly: a note written back, as
# "raindown server" answers it. The request is a file, /request.json, so the note's never quoted into Ruby code, and the
# vault is at /vault, as the worker mirrors it.
module RaindownEngine
  # A date in front matter, like 2024-01-02, which YAML reads as a Date, and Obsidian leaves as text.
  DATE = /\A\d{4}-\d{2}-\d{2}\z/

  module_function

  # The plugin's told of every change to the vault, so Raindown doesn't check each file's modified time each time it
  # lists them, and gives the front matter Obsidian's already read, by path, so Raindown doesn't read it.
  def watch(file)
    front_matters = JSON.parse(File.read(file), symbolize_names: true)
    Raindown::Pages.watch(front_matters.to_h { |path, front_matter| [path.to_s, dated(front_matter)] })
  end

  # The note as Raindown writes it back, with its warnings, or the error that stopped it, as JSON, after the files the
  # vault's changed since the last one.
  def answer(file)
    request = JSON.parse(File.read(file))
    Raindown::Pages.changed(request.fetch('changed', []))
    JSON.generate(answered(request, request.fetch('markdown'), path: request.fetch('path'), bare: request['bare'] == true))
  rescue StandardError, ScriptError => e
    JSON.generate(error: e.message)
  end

  # Rendered as Markdown, for reading view, which Obsidian renders itself, or written back, running its endpoints with
  # execute.
  def answered(request, markdown, **options)
    return { output: Raindown::Editing.render_markdown(markdown, **options, commonmark: false) } if request['render']

    Raindown::Editing.rewrite_markdown(markdown, **options, execute: request['execute'] == true)
  end

  def dated(value)
    case value
    when Hash then value.transform_values { dated(it) }
    when Array then value.map { dated(it) }
    when DATE then Date.parse(value)
    else value
    end
  end
end
