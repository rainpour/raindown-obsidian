# frozen_string_literal: true

# Builds ruby.wasm's module for the plugin, as ruby.wasm's npm package builds its own, with rbwasm and the js gem, but
# with only the extensions Raindown and a vault's nodes use. It leaves out OpenSSL, as Obsidian makes the plugin's HTTPS
# requests, and WebAssembly has no sockets, and ripper, objspace, coverage and continuation, which only tools use. It
# also leaves out the transcoders for Chinese, Japanese and Korean character sets, and Japanese phones' emoji, which
# are 2.6 MB of tables, as Raindown reads UTF-8, which every language's text in Obsidian is in. Ruby's
# enc/make_encmake.rb takes them as --no-transes in ENCS, from the environment, as it was before Bundler loaded, which
# rbwasm builds Ruby with, so this runs itself again with it. rbwasm doesn't count it in reusing a Ruby it built
# before, so it's built clean. Ruby's source is patched with wasm/patches, which make its jumps, like an exception, a
# break or an ensure, many times faster in WebAssembly, as each patch says. rbwasm only
# patches the source as it extracts it, so one extracted before is extracted again. Then it strips its debug sections,
# as the npm package's is. It isn't packed with Ruby's files, with wasi-vfs, which can't compile the module without
# Asyncify, but main.js has them, which the worker gives Ruby, so both modules have them once.
# With --jspi, it's the module without Asyncify, for engines with JSPI, patched with wasm/patches/jspi,
# rather than the jumps patch, from the wasi-sdk WASI_SDK_PATH is and the Binaryen BINARYEN is, which bin/build
# downloads, put first in PATH here, where rbwasm finds wasm-opt, as Bundler gives PATH back as it was before bin/build.
# bin/build runs it, with wasm/Gemfile's gems:
#   BUNDLE_GEMFILE=wasm/Gemfile RUBY_WASM_ROOT=build/ruby_wasm bundle exec ruby scripts/ruby_wasm.rb OUTPUT [--jspi]
require 'fileutils'
require 'ruby_wasm'
require 'ruby_wasm/cli'
require 'tmpdir'

RUBY_VERSION_BUILT = '4.0'
JSPI = ARGV.include?('--jspi')
PATCHES = Dir[File.expand_path("../wasm/patches/ruby-#{RUBY_VERSION_BUILT}-*.patch", __dir__)]
          .then { JSPI ? it.grep_v(/-jumps\.patch\z/) + Dir[File.expand_path('../wasm/patches/jspi/*.patch', __dir__)] : it }
          .sort.freeze

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

# Without Asyncify, with --jspi: setjmp from WebAssembly exception handling, and RB_WASM_EH, for the patch, and
# wasm-opt's options without -g, as Binaryen's DWARF handling fails on Ruby's, after the patched configure's passes.
module WithoutAsyncify
  EH = '-mllvm -wasm-enable-sjlj -mexception-handling'

  def configure_args(build_triple, toolchain)
    args = super.filter_map do |arg|
      case arg
      when /\ACFLAGS=/, /\ALDFLAGS=/ then "#{arg} #{EH}"
      when /\Acppflags=/ then "#{arg} -DRB_WASM_EH"
      when /\Awasmoptflags=/ then nil
      else arg
      end
    end
    args + ['LIBS=-lsetjmp', 'wasmoptflags=-O3 --strip-dwarf --enable-exception-handling']
  end
end
if JSPI
  RubyWasm::CrossRubyProduct.prepend(WithoutAsyncify)
  ENV['PATH'] = "#{File.join(ENV.fetch('BINARYEN'), 'bin')}#{File::PATH_SEPARATOR}#{ENV.fetch('PATH')}"
end

# The module as it's linked, without wasi-vfs packing Ruby's files into it, which main.js has, once rbwasm's extension,
# with wasi-vfs, loads.
module Unpacked
  def pack(wasm_bytes) = wasm_bytes
end

module UnpackedExtension
  private

  def require_extension
    super
    RubyWasmExt::WasiVfs.prepend(Unpacked)
  end
end
RubyWasm::CLI.prepend(UnpackedExtension)

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
puts format('Built ruby.wasm%s: %.1f MB, with %s, patched with %s', JSPI ? ' without Asyncify' : '', File.size(output) / 1e6, EXTENSIONS.tr(',', ' '),
            PATCHES.map { File.basename(it) }.join(', '))
