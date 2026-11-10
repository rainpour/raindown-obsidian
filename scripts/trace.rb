# frozen_string_literal: true

# Writes back a vault of notes using each of Raindown's directives, and a project node in Ruby and in Markdown, then
# lists every Ruby file that loaded, in build/loaded.json, for bin/build to pack into the WebAssembly module and no more:
# the standard library's, by their paths in its folder, with this Ruby's platform folder as WebAssembly's, and each
# gem's folder, load paths and the files that loaded from it. Run natively, from a Raindown checkout, as bin/build does:
#   bundle exec ruby -rrbconfig -I PLUGIN/src PLUGIN/scripts/trace.rb PLUGIN/build/loaded.json
# Bundler only finds the gems. Then it runs again without Bundler or RubyGems, from the gems' folders, as Ruby does in
# WebAssembly. Gems with native code, like json, are left to the standard library, which has them built in.
require 'tmpdir'
require 'engine'

NOTES = {
  'toc.md' => "# Notes\n\n<!-- toc: -->\n<!-- :toc -->\n\n## One\n\n## Two\n",
  'list.md' => "<!-- list: folder: 'notes' -->\n<!-- :list -->\n",
  'notes/a.md' => "---\ntags: [a]\n---\n\n# A\n",
  'table.md' => "<!-- table: 'data.csv' -->\n<!-- :table -->\n",
  'chart.md' => "<!-- chart: 'data.csv' -->\n<!-- :chart -->\n",
  'bare.md' => "---\nraindown: true\n---\n\ntoc:\n\n# Bare\n\nShout:\n",
  'nodes.md' => "<!-- Shout: -->\n<!-- :Shout -->\n\n<!-- Whisper: -->\n<!-- :Whisper -->\n",
  'data.csv' => "Item,Cost\nMilk,54\nEggs,68\n",
  '.raindown/shout.rb' => "class Shout < Raindown::Node\n  def rewrite = 'Loud'\nend\n",
  '.raindown/whisper.md' => "quiet\n",
  '.obsidian/app.json' => "{}\n"
}.freeze

Dir.mktmpdir do |vault|
  NOTES.each do |path, text|
    FileUtils.mkdir_p(File.dirname(File.join(vault, path)))
    File.write(File.join(vault, path), text)
  end
  request = File.join(vault, 'request.json')
  NOTES.each_key.select { it.end_with?('.md') }.each do |path|
    File.write(request, JSON.generate(path: File.join(vault, path), markdown: NOTES[path]))
    answer = JSON.parse(RaindownEngine.answer(request))
    abort "#{path}: #{answer['error']}" if answer['error']
  end
end

loaded = $LOADED_FEATURES.select { it.end_with?('.rb') }

if defined?(Bundler)
  gems = Gem.loaded_specs.values.select do |spec|
    spec.name != 'bundler' && spec.extensions.empty? && loaded.any? { it.start_with?("#{spec.full_gem_path}/") }
  end
  gems = gems.sort_by(&:name).to_h { [it.name, { root: it.full_gem_path, require_paths: it.require_paths }] }
  paths = [File.expand_path(__dir__ + '/../src'), *gems.values.flat_map { |gem| gem[:require_paths].map { File.join(gem[:root], it) } }]
  Bundler.with_unbundled_env do
    ENV['RAINDOWN_TRACE_GEMS'] = JSON.generate(gems)
    exec(RbConfig.ruby, '--disable-gems', '-rrbconfig', *paths.map { "-I#{it}" }, __FILE__, *ARGV)
  end
end

lib = RbConfig::CONFIG['rubylibdir']
stdlib = loaded.select { it.start_with?("#{lib}/") }
gems = JSON.parse(ENV.fetch('RAINDOWN_TRACE_GEMS')).to_h do |name, gem|
  [name, gem.merge('files' => loaded.filter_map { it.delete_prefix("#{gem['root']}/") if it.start_with?("#{gem['root']}/") }.sort)]
end
File.write(ARGV.fetch(0), JSON.pretty_generate(
  stdlib: stdlib.map { it.delete_prefix("#{lib}/").sub("#{RbConfig::CONFIG['arch']}/", 'wasm32-wasi/') }.sort, gems:
))
puts "#{stdlib.size} standard library files and #{gems.size} gems loaded"
