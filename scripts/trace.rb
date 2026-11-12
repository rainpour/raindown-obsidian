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

# The Ruby files read as text, rather than only loaded, like those Lowkey parses for a class that includes LowType,
# whose source bin/build packs as well as their bytecode.
module ReadSources
  def self.files
    @files ||= Set.new
  end

  def read(path, ...)
    ReadSources.files << File.expand_path(path.to_s) if path.to_s.end_with?('.rb')
    super
  end
end
File.singleton_class.prepend(ReadSources)

require 'engine'

VAULT = File.expand_path('../test/vault', __dir__)
# Gems with native code that Raindown loads natively, which the plugin does without, like quickjs, as its worker runs
# JavaScript nodes.
NATIVE_ONLY = %w[quickjs].freeze

# The vault's JavaScript nodes, which Raindown runs in QuickJS natively, run in a process of its own here, so what QuickJS
# loads, like OpenSSL, isn't packed, as the plugin's worker runs them itself.
class ForkedQuickJS
  def initialize
    requests, @requests = IO.pipe
    @replies, replies = IO.pipe
    fork do
      @requests.close
      @replies.close
      answer(requests, replies)
    end
    requests.close
    replies.close
  end

  def request(**message)
    @requests.puts(JSON.generate(message))
    reply = JSON.parse(@replies.gets)
    raise Raindown::JSNodes::Error, reply['error'] if reply['error']

    reply
  end

  private

  def answer(requests, replies)
    require 'raindown/js/quickjs_host'
    host = Raindown::JSNodes::QuickJSHost.new
    requests.each_line do |line|
      replies.puts(JSON.generate(answered(host, JSON.parse(line, symbolize_names: true))))
      replies.flush
    end
    exit!(0)
  end

  def answered(host, message)
    host.request(**message)
  rescue Raindown::JSNodes::Error => e
    { error: e.message }
  end
end
Raindown::JSNodes.host = ForkedQuickJS.new

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
  # Native gems Raindown only uses natively, like quickjs for JavaScript nodes, which the plugin's worker runs itself,
  # are on the load path, so the trace runs them, but aren't packed.
  native_only = NATIVE_ONLY.filter_map { Gem.loaded_specs[it] }.flat_map(&:full_require_paths)
  paths = [File.expand_path(__dir__ + '/../src'), *gems.values.flat_map { |gem| gem[:require_paths].map { File.join(gem[:root], it) } },
           *native_only]
  Bundler.with_unbundled_env do
    ENV['RAINDOWN_TRACE_GEMS'] = JSON.generate(gems)
    exec(RbConfig.ruby, '--disable-gems', '-rrbconfig', *paths.map { "-I#{it}" }, __FILE__, *ARGV)
  end
end

lib = RbConfig::CONFIG['rubylibdir']

# A file's path in WebAssembly's Ruby, as bin/build packs it, when it's packed.
def packed_path(file, lib, gems)
  return "/usr/local/lib/ruby/3.4.0/#{file.delete_prefix("#{lib}/")}" if file.start_with?("#{lib}/")

  name, gem = gems.find { |_, gem| file.start_with?("#{gem['root']}/") }
  "/gems/#{name}/#{file.delete_prefix("#{gem['root']}/")}" if gem
end
stdlib = loaded.select { it.start_with?("#{lib}/") }
gems = JSON.parse(ENV.fetch('RAINDOWN_TRACE_GEMS')).to_h do |name, gem|
  [name, gem.merge('files' => loaded.filter_map { it.delete_prefix("#{gem['root']}/") if it.start_with?("#{gem['root']}/") }.sort)]
end
File.write(ARGV.fetch(0), JSON.pretty_generate(
  stdlib: stdlib.map { it.delete_prefix("#{lib}/").sub("#{RbConfig::CONFIG['arch']}/", 'wasm32-wasi/') }.sort, gems:,
  answers:, renders:,
  read: ReadSources.files.filter_map { |file| packed_path(file, lib, gems) }.sort
))
puts "#{stdlib.size} standard library files and #{gems.size} gems loaded"
