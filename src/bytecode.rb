# frozen_string_literal: true

# Loads each Ruby file from its bytecode, which bin/build compiled ahead of time and packed at /bytecode, rather than
# parsing and compiling its source, as Bootsnap does, which halves how long Raindown takes to load. Ruby asks load_iseq
# for each file it loads, and compiles the source itself when it returns nil, like for a project's own nodes. A packed
# file's source is empty, as only its bytecode's packed, so when its bytecode won't load, that's raised, rather than
# loading nothing.
class RubyVM::InstructionSequence # rubocop:disable Style/ClassAndModuleChildren -- reopens Ruby's own class
  # Every file's bytecode, where the worker gives Ruby's files as one, /bytecode.bin, with where each is in it, in
  # /bytecode.idx, read once, rather than opening each file, or else nil, to read each from its file.
  INDEX = File.exist?('/bytecode.idx') && File.read('/bytecode.idx').lines(chomp: true).to_h do |line|
    path, at, size = line.split
    [path, [at.to_i, size.to_i]]
  end
  BYTECODE = INDEX && File.binread('/bytecode.bin')

  def self.load_iseq(path)
    bytecode = bytecode_of(path)
    return unless bytecode

    load_from_binary(bytecode)
  rescue RuntimeError => e
    raise LoadError, "#{path}'s bytecode didn't load: #{e.message}" if File.zero?(path)

    nil
  end

  def self.bytecode_of(path)
    return INDEX[path] && BYTECODE.byteslice(*INDEX[path]) if INDEX

    file = "/bytecode#{path}.yarb"
    File.binread(file) if File.exist?(file)
  end
  private_class_method :bytecode_of
end
