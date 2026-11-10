# frozen_string_literal: true

# Writes back test/vault, with notes using each of Raindown's directives, and a project node in Ruby and in Markdown,
# then lists, in build/loaded.json, its answers, written back and rendered for reading view, for scripts/smoke.js to
# check the plugin's against, and every Ruby file
# that loaded, for bin/build to pack into the WebAssembly module and no more: the standard library's, by their paths in its folder, with this Ruby's platform folder as WebAssembly's, and each
# gem's folder, load paths and the files that loaded from it. Run natively, from a Raindown checkout, as bin/build does:
#   bundle exec ruby -rrbconfig -I PLUGIN/src PLUGIN/scripts/trace.rb PLUGIN/build/loaded.json
# Bundler only finds the gems. Then it runs again without Bundler or RubyGems, from the gems' folders, as Ruby does in
# WebAssembly. Gems with native code, like json, or prism, even precompiled, are left to the standard library, which has
# them built in, as their Ruby must match the code built into WebAssembly's Ruby.
require 'tmpdir'
require 'engine'

VAULT = File.expand_path('../test/vault', __dir__)

# Native Raindown's answers, by each note's path, written back and rendered, which scripts/smoke.js checks the
# plugin's match.
answers, renders = [false, true].map do |render|
  Dir.mktmpdir do |vault|
    FileUtils.cp_r("#{VAULT}/.", vault)
    request = File.join(vault, 'request.json')
    Dir.glob('**/*.md', base: VAULT).sort.to_h do |path|
      File.write(request, JSON.generate(path: File.join(vault, path), markdown: File.read(File.join(VAULT, path)), render:))
      answer = JSON.parse(RaindownEngine.answer(request))
      abort "#{path}: #{answer['error']}" if answer['error']
      [path, answer['output']]
    end
  end
end

loaded = $LOADED_FEATURES.select { it.end_with?('.rb') }

if defined?(Bundler)
  native = $LOADED_FEATURES.grep(/\.(?:so|bundle)\z/)
  gems = Gem.loaded_specs.values.select do |spec|
    inside = ->(file) { file.start_with?("#{spec.full_gem_path}/") }
    spec.name != 'bundler' && spec.extensions.empty? && native.none?(&inside) && loaded.any?(&inside)
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
  stdlib: stdlib.map { it.delete_prefix("#{lib}/").sub("#{RbConfig::CONFIG['arch']}/", 'wasm32-wasi/') }.sort, gems:,
  answers:, renders:
))
puts "#{stdlib.size} standard library files and #{gems.size} gems loaded"
