# frozen_string_literal: true

# Loads each Ruby file from its bytecode, which bin/build compiled ahead of time and packed at /bytecode, rather than
# parsing and compiling its source, as Bootsnap does, which halves how long Raindown takes to load. Ruby asks load_iseq
# for each file it loads, and compiles the source itself when it returns nil, like for a project's own nodes. A packed
# file's source is empty, as only its bytecode's packed, so when its bytecode won't load, that's raised, rather than
# loading nothing.
class RubyVM::InstructionSequence # rubocop:disable Style/ClassAndModuleChildren -- reopens Ruby's own class
  def self.load_iseq(path)
    bytecode = "/bytecode#{path}.yarb"
    return unless File.exist?(bytecode)

    load_from_binary(File.binread(bytecode))
  rescue RuntimeError => e
    raise LoadError, "#{path}'s bytecode didn't load: #{e.message}" if File.zero?(path)

    nil
  end
end
