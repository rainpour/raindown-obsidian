# frozen_string_literal: true

# Compiles each Ruby file in the list, a file with one path a line, to bytecode, in the out folder, at its path with .yarb after it, like
# /bytecode/gems/raindown/lib/raindown.rb.yarb, so src/bytecode.rb can load it rather than parsing and compiling it.
# Bytecode only loads in the Ruby it was compiled by, so bin/build runs this in Ruby compiled to WebAssembly.
#   ruby compile.rb /bytecode /compile.txt
# Without FileUtils, which the module only has when Raindown loads it.
def make_folder(folder)
  File.directory?(folder) || (make_folder(File.dirname(folder)) && Dir.mkdir(folder))
end

out, list = ARGV
compiled = failed = 0
File.readlines(list, chomp: true).each do |file|
  bytecode = File.join(out, "#{file}.yarb")
  make_folder(File.dirname(bytecode))
  File.binwrite(bytecode, RubyVM::InstructionSequence.compile_file(file).to_binary)
  compiled += 1
rescue SyntaxError, StandardError => e
  warn "Can't compile #{file}: #{e.message}"
  failed += 1
end
puts "Compiled #{compiled} files to bytecode#{", #{failed} failed" if failed.positive?}"
