# frozen_string_literal: true

# Builds ruby.wasm's module for the plugin, as ruby.wasm's npm package builds its own, with rbwasm and the js gem, but
# with only the extensions Raindown and a vault's nodes use. It leaves out OpenSSL, as Obsidian makes the plugin's HTTPS
# requests, and WebAssembly has no sockets, and ripper, objspace, coverage and continuation, which only tools use. Then
# it strips its debug sections, as the npm package's is. bin/build runs it, with wasm/Gemfile's gems:
#   BUNDLE_GEMFILE=wasm/Gemfile RUBY_WASM_ROOT=build/ruby_wasm bundle exec ruby scripts/ruby_wasm.rb OUTPUT
require 'ruby_wasm'
require 'ruby_wasm/cli'
require 'tmpdir'

EXTENSIONS = %w[
  cgi/escape date digest digest/bubblebabble digest/md5 digest/rmd160 digest/sha1 digest/sha2 etc fcntl json
  json/generator json/parser monitor pathname psych rbconfig/sizeof stringio strscan zlib
].join(',')

# rbwasm's full build, with Raindown's extensions rather than all of Ruby's.
module RaindownExtensions
  private

  def build_config(options)
    super.merge(default_exts: EXTENSIONS)
  end
end
RubyWasm::CLI.prepend(RaindownExtensions)

# A WebAssembly module's bytes without its custom sections for debugging: DWARF's, named .debug_*, and its functions'
# names.
module Stripped
  module_function

  def module_bytes(bytes)
    kept = [bytes.byteslice(0, 8)]
    at = 8
    while at < bytes.bytesize
      size, body = leb128(bytes, at + 1)
      kept << bytes.byteslice(at, body + size - at) unless debug?(bytes, at, body)
      at = body + size
    end
    kept.join
  end

  def debug?(bytes, at, body)
    return false unless bytes.getbyte(at).zero?

    length, name = leb128(bytes, body)
    section = bytes.byteslice(name, length)
    section == 'name' || section.start_with?('.debug')
  end

  # An unsigned LEB128 number at a position, and the position after it.
  def leb128(bytes, at)
    value = 0
    shift = 0
    loop do
      byte = bytes.getbyte(at)
      at += 1
      value |= (byte & 0x7f) << shift
      shift += 7
      return [value, at] if byte < 0x80
    end
  end
end

output = ARGV.fetch(0)
Dir.mktmpdir do |dir|
  built = File.join(dir, 'ruby.wasm')
  RubyWasm::CLI.new(stdout: $stdout, stderr: $stderr).run(
    ['build', '--ruby-version', '3.4', '--target', 'wasm32-unknown-wasip1', '--build-profile', 'full', '--no-stdlib',
     '-o', built]
  )
  File.binwrite(output, Stripped.module_bytes(File.binread(built)))
end
puts format('Built ruby.wasm: %.1f MB, with %s', File.size(output) / 1e6, EXTENSIONS.tr(',', ' '))
