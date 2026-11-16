# Which of a module's functions can reach garbage collection, and how many call sites call one that can't, from its
# text, as binaryen-131-spill-pointers.patch finds them: those that read the stack, make an indirect call, or call an
# import that can call back into Ruby, or switch Fibers, or call such a function. The functions in hot code, the VM,
# blocks, hashes and arrays, are counted on their own.
#   wasm-opt ruby.wasm --all-features --print > ruby.wat && ruby gc_reach.rb ruby.wat [functions that can't.txt]
require 'set'

ROOTS = %w[rb_gc_mark_roots rb_gc_mark_locations each_location gc_start].freeze
wat = ARGV.fetch(0)
calls = Hash.new { |h, k| h[k] = [] }
indirect = {}
imports = {}
current = nil
File.foreach(wat) do |line|
  if (m = line.match(/^ \(import "([^"]+)" "([^"]+)" \(func \$(\S+)/))
    imports[m[3]] = m[1]
  elsif (m = line.match(/^ \(func \$(\S+)/))
    current = m[1]
    calls[current]
  elsif current
    line.scan(/\((?:return_)?call \$([^\s)]+)/) { calls[current] << it[0] }
    indirect[current] = true if line.match?(/\((?:return_)?call_(?:indirect|ref)\b/)
  end
end
safe_imports = %w[wasi_snapshot_preview1 canonical_abi]
gc = Set.new(ROOTS & calls.keys)
gc.merge(imports.reject { |_, mod| safe_imports.include?(mod) }.keys)
gc.merge(indirect.keys)
callers = Hash.new { |h, k| h[k] = [] }
calls.each { |f, targets| targets.uniq.each { callers[it] << f } }
queue = gc.to_a
until queue.empty?
  callers[queue.pop].each { |f| queue << f if gc.add?(f) }
end
sites = calls.values.flatten
safe = sites.count { !gc.include?(it) }
puts "functions #{calls.size}, can reach GC #{(calls.keys & gc.to_a).size}"
puts "direct call sites #{sites.size}, to functions that can't reach GC #{safe} (#{(safe * 100.0 / sites.size).round}%)"
puts "most called safe targets: " + sites.reject { gc.include?(it) }.tally.max_by(15, &:last).map { |f, n| "#{f} #{n}" }.join(', ')
File.write(ARGV.fetch(1), (calls.keys - gc.to_a).sort.join("\n")) if ARGV[1]
hot = /\A(vm_exec_core|vm_call|vm_callee|invoke_block|rb_yield|rb_ary_|rb_hash_|hash_|st_|rb_vm_|vm_)/
hot_sites = calls.select { |f, _| f.match?(hot) }.values.flatten
hot_safe = hot_sites.reject { gc.include?(it) }
puts "in hot functions: #{hot_sites.size} direct call sites, #{hot_safe.size} to functions that can't reach GC (#{(hot_safe.size * 100.0 / hot_sites.size).round}%): " + hot_safe.tally.max_by(12, &:last).map { |f, n| "#{f} #{n}" }.join(', ')
