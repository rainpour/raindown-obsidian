# frozen_string_literal: true

# scripts/ruby_wasm.rb's module, with the plugin's extensions and the js gem, but without Asyncify: this folder's patch
# and the shapes patch, rather than the jumps patch, setjmp from WebAssembly exception handling, and pointers spilled
# for garbage collection, as build.sh builds it. Fibers trap, so the worker can't use evalAsync, and a vault's
# JavaScript components and Raindown's services, which need it, don't work.
# With a wasi-sdk, like wasi-sdk 34, and a Binaryen with --spill-pointers, like version_131, first in PATH, in a root of
# its own, as rbwasm deletes Ruby's checkout in its root:
#   WASI_SDK_PATH=... PATH=BINARYEN/bin:$PATH RUBY_WASM_ROOT=... BUNDLE_GEMFILE=wasm/Gemfile \
#     bundle exec ruby wasm/experiments/without-asyncify/ruby_wasm.rb OUTPUT
require 'fileutils'
require 'ruby_wasm'
require 'ruby_wasm/cli'
require 'tmpdir'

RUBY_VERSION_BUILT = '4.0'
PATCHES = [File.join(__dir__, 'ruby-4.0-without-asyncify.patch'),
           File.expand_path('../../patches/ruby-4.0-wasm-shapes.patch', __dir__)].freeze

TRANSCODERS_LEFT_OUT = %w[
  big5 chinese gb18030 gbk korean japanese japanese_euc japanese_sjis iso2022 emoji emoji_iso2022_kddi emoji_sjis_docomo
  emoji_sjis_kddi emoji_sjis_softbank utf8_mac
].join(' ')
ENCS = "--no-transes='#{TRANSCODERS_LEFT_OUT}'".freeze
# Ruby 4.0's psych takes libyaml from pkg-config before the one rbwasm built for WebAssembly, and pkg-config finds this
# computer's, like Homebrew's, which can't be linked. With nowhere to look, a folder that isn't there, it finds none.
BUILD_ENV = { 'ENCS' => ENCS, 'PKG_CONFIG_LIBDIR' => File.join(__dir__, 'no-pkg-config') }.freeze
unless Bundler.original_env.slice(*BUILD_ENV.keys) == BUILD_ENV
  Bundler.with_original_env { exec(BUILD_ENV, 'bundle', 'exec', 'ruby', __FILE__, *ARGV) }
end

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

# The Ruby rbwasm builds for this computer, to build WebAssembly's with, as rbwasm builds it, but without OpenSSL, which
# building Ruby doesn't use, and Ruby 4.0.0's doesn't compile with OpenSSL 4, which Homebrew has.
module HostRubyWithoutOpenSSL
  def build(executor)
    executor.mkdir_p(product_build_dir)
    @source.build(executor)
    return if Dir.exist?(install_dir)

    executor.system(@source.configure_file, "--prefix=#{install_dir}", '--disable-install-doc', '--with-out-ext=openssl',
                    chdir: product_build_dir)
    executor.system('make', "-j#{executor.process_count}", 'install', chdir: product_build_dir)
  end
end
RubyWasm::BaseRubyProduct.prepend(HostRubyWithoutOpenSSL)

# Without Asyncify: setjmp from WebAssembly exception handling, RB_WASM_EH for the prototype patch, and wasm-opt
# spilling pointers for garbage collection, as the patched configure has it, rather than Asyncify, without -g, as
# Binaryen 131's DWARF handling fails on Ruby's.
module WithoutAsyncify
  EH = '-mllvm -wasm-enable-sjlj -mexception-handling'

  def configure_args(build_triple, toolchain)
    args = super.map do |arg|
      case arg
      when /\ACFLAGS=/, /\ALDFLAGS=/ then "#{arg} #{EH}"
      when /\Acppflags=/ then "#{arg} -DRB_WASM_EH"
      when /\Awasmoptflags=/ then nil
      else arg
      end
    end
    args.compact + ['LIBS=-lsetjmp', 'wasmoptflags=-O3 --strip-dwarf --enable-exception-handling']
  end
end
RubyWasm::CrossRubyProduct.prepend(WithoutAsyncify)

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
# Ruby's source as rbwasm extracted it for a build before, with that build's patches, in rbwasm's root, as it finds it.
FileUtils.rm_rf(File.join(File.expand_path(ENV['RUBY_WASM_ROOT'] || Bundler.root), 'build', 'checkouts', RUBY_VERSION_BUILT))
Dir.mktmpdir do |dir|
  built = File.join(dir, 'ruby.wasm')
  RubyWasm::CLI.new(stdout: $stdout, stderr: $stderr).run(
    ['build', '--ruby-version', RUBY_VERSION_BUILT, '--target', 'wasm32-unknown-wasip1', '--build-profile', 'full',
     '--no-stdlib', '--clean', *PATCHES.flat_map { ['--patch', it] }, '-o', built]
  )
  File.binwrite(output, Stripped.module_bytes(File.binread(built)))
end
puts format('Built ruby.wasm without Asyncify: %.1f MB, with %s, patched with %s', File.size(output) / 1e6, EXTENSIONS.tr(',', ' '),
            PATCHES.map { File.basename(it) }.join(', '))
