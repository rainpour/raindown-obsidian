# frozen_string_literal: true

# Ruby's jumps, like an exception, a break, a throw or an ensure, through its C, where wasm/patches changes how
# they're caught in WebAssembly: each case's result, a line each, which scripts/jumps.js checks is the same in the
# plugin's ruby.wasm, run directly and in a Fiber, as in native Ruby. The last cases run under GC.stress, as garbage
# collection reads the stack by unwinding it, through the same code, with Asyncify, while without it, it only
# collects between requests, so not here. It's evaluated, with IN_FIBER set before it, as
# a stack overflow is only caught in a Fiber in WebAssembly, and its value is its lines.
require 'json'
require 'monitor'
require 'stringio'
require 'date'
require 'yaml'

OUT = []
# A folder to write files in: the root of ruby.wasm's in-memory files, or a temporary one natively, with tmpdir, which the
# plugin doesn't pack.
def files_root
  return '' if RUBY_PLATFORM.include?('wasm')

  require 'tmpdir'
  Dir.mktmpdir
end
ROOT = files_root
FILE = "#{ROOT}/jumps_file.txt"
File.write(FILE, "first line\nsecond\n")
def t(name)
  OUT << "#{name}: #{yield.inspect}"
rescue Exception => e
  OUT << "#{name}: !#{e.class}: #{e.message[0, 80].sub(ROOT, '')}"
end
S = Struct.new(:a)
def suite(stress)
  log = []
  t('break range') { (1..5).each { break it * 2 if it == 3 } }
  t('break hash') { { a: 1, b: 2 }.each { |k, v| break k if v == 2 } }
  t('break map') { (1..5).map { break :out if it == 2; it } }
  t('break nested') { (1..3).map { |a| (1..3).each { |b| break b * a if b == 2 } } }
  t('next range') { (1..4).map { next 0 if it.even?; it } }
  t('return lambda') { f = -> { (1..3).each { return it if it == 2 }; :no }; [f.(), f.()] }
  t('return method') { o = Object.new; def o.f = { a: 1 }.each { |k, _| return k }; o.f }
  t('return proc in method') { o = Object.new; def o.f(h) = (h.each_pair { |k, v| return [k, v] if v > 1 }; nil); o.f(a: 1, b: 2) }
  t('throw') { catch(:done) { (1..3).each { |a| { x: 1 }.each { throw :done, a if a == 2 } }; :never } }
  t('throw nested catch') { catch(:a) { catch(:b) { throw :a, 1 }; 2 } }
  t('throw inner') { catch(:a) { [catch(:b) { throw :b, 1 }, 2] } }
  t('uncaught throw') { throw :nope }
  t('catch no arg') { catch { |tag| throw tag, 7 } }
  t('raise through each') { begin; (1..3).each { raise ArgumentError, 'bad' if it == 2 }; rescue ArgumentError => e; e.message; end }
  t('raise through hash') { begin; { a: 1 }.each { raise 'h' }; rescue => e; e.message; end }
  t('hash iteration level after raise') { h = { a: 1 }; begin; h.each { raise 'x' }; rescue; end; h[:b] = 2; h }
  t('hash add in each') { h = { a: 1 }; h.each { h[:z] = 1 } }
  t('hash after break') { h = { a: 1 }; h.each { break }; h[:c] = 3; h }
  t('ensure order') { begin; { a: 1 }.each { begin; raise 'in'; ensure; log << :e1; end }; rescue; log << :r; ensure; log << :e2; end; log.dup }
  t('ensure with break') { log.clear; (1..3).each { begin; break; ensure; log << it; end }; log.dup }
  t('raise in ensure') { begin; begin; raise 'a'; ensure; raise 'b'; end; rescue => e; [e.message, e.cause&.message]; end }
  t('mutex raise') { m = Mutex.new; begin; m.synchronize { raise 'm' }; rescue; end; [m.locked?, m.synchronize { 1 }] }
  t('mutex break') { m = Mutex.new; r = m.synchronize { [1].each { break 5 } }; [r, m.locked?] }
  t('monitor nested') { m = Monitor.new; m.synchronize { m.synchronize { 3 } } }
  t('monitor raise') { m = Monitor.new; begin; m.synchronize { raise 'm' }; rescue; end; m.synchronize { 4 } }
  t('file open ensure') { f = nil; begin; File.open(FILE) { f = it; raise 'io' }; rescue; end; f.closed? }
  t('file missing') { File.read('/nope/missing.txt') }
  t('file exist') { [File.exist?('/nope'), File.exist?(FILE), File.file?(FILE), File.directory?('/')] }
  t('file read') { File.read(FILE).lines.first.chomp }
  t('file foreach break') { File.foreach(FILE) { break it.size } }
  t('file write read') { File.write("#{ROOT}/jumps_written.txt", "a\nb\n"); [File.readlines("#{ROOT}/jumps_written.txt", chomp: true), File.size("#{ROOT}/jumps_written.txt")] }
  t('dir missing') { Dir.children('/nope') }
  t('require missing') { require 'no_such_feature' }
  t('require loaded') { [require('json'), require('date')] }
  t('require raise') { File.write("#{ROOT}/jumps_bad.rb", "raise 'load failed'\n"); require "#{ROOT}/jumps_bad" }
  t('require again after raise') { File.write("#{ROOT}/jumps_ok.rb", "JUMPS_OK = (defined?(JUMPS_OK) ? JUMPS_OK + 1 : 1)\n"); [require("#{ROOT}/jumps_ok"), require("#{ROOT}/jumps_ok"), JUMPS_OK] }
  t('syntax error') { begin; eval('1 +'); rescue SyntaxError; :syntax_error; end }
  t('recursive inspect') { a = [1]; a << a; h = { k: 1 }; h[:self] = h; [a.inspect, h.inspect] }
  t('recursive eq') { a = [1]; a << a; b = [1]; b << b; [a == a, [1, [2]] == [1, [2]], { a: [1] } == { a: [1] }, S.new([1]) == S.new([1])] }
  t('recursive hash') { a = [1]; a << a; [a.hash == a.hash, [[1], { a: 1 }].hash == [[1], { a: 1 }].hash] }
  t('recursive join') { a = [1]; a << a; a.join(',') }
  t('recursive flatten') { a = [1]; a << a; a.flatten }
  t('eq raising') { o = Object.new; def o.==(_) = raise('eq'); [[o] == [1], 1] }
  t('eq raising then again') { o = Object.new; def o.==(_) = raise('eq'); ([o] == [1] rescue :raised); [[1, [2]] == [1, [2]], [1].inspect] }
  t('inspect raising') { o = Object.new; def o.inspect = raise('insp'); ([o].inspect rescue :raised); [[1, [2]].inspect] }
  t('cmp arrays') { [[2, 1], [1, 2], [1, 1]].sort }
  t('uniq arrays') { [[1], [1], [2]].uniq }
  t('raise frozen') { e = ArgumentError.new('fz').freeze; begin; raise e; rescue => x; [x.message, x.frozen?, x.equal?(e), x.backtrace.class]; end }
  t('raise cause') { begin; begin; raise 'a'; rescue; raise TypeError, 'b'; end; rescue => e; [e.class, e.cause.message, e.backtrace_locations.first.lineno.positive?]; end }
  t('raise class') { begin; raise IOError; rescue => e; [e.message, e.backtrace.size.positive?]; end }
  t('raise non exception') { raise 5 }
  t('retry') { n = 0; begin; n += 1; raise 'r' if n < 3; n; rescue; retry; end }
  t('rescue modifier') { [(Integer('x') rescue :bad), Integer('x', exception: false), Float('1.5'), (Float('z') rescue :f)] }
  t('exception in rescue') { begin; begin; raise 'a'; rescue => e; raise "b after #{e.message}"; end; rescue => e; e.message; end }
  t('method_missing') { o = Object.new; def o.method_missing(n, *a) = n == :zz ? a : super; [o.zz(1), (o.yy rescue :nm)] }
  t('to_proc') { %w[a b].map(&:upcase) }
  t('enumerator next') { e = [1, 2].each; [e.next, e.next, (e.next rescue :stop)] }
  t('enumerator loop') { e = [1, 2, 3].each; r = []; loop { r << e.next }; r }
  t('enumerator peek') { e = (1..3).each_slice(2); [e.next, e.peek, e.next] }
  t('lazy') { (1..Float::INFINITY).lazy.map { it * 2 }.select { it % 3 == 0 }.first(3) }
  t('fiber') { f = Fiber.new { |x| y = Fiber.yield(x + 1); begin; Fiber.yield(y * 2); ensure; log << :fe; end; :end }; [f.resume(1), f.resume(5), f.resume, f.alive?] }
  t('fiber raise') { f = Fiber.new { raise 'in fiber' }; begin; f.resume; rescue => e; e.message; end }
  t('fiber break in fiber') { Fiber.new { (1..3).each { break it if it == 2 } }.resume }
  t('fiber catch across') { f = Fiber.new { catch(:x) { Fiber.yield 1; throw :x, 2 } }; [f.resume, f.resume] }
  t('fiber many raises') { Fiber.new { 3000.times { begin; { a: 1 }.each { raise 'x' }; rescue; end }; :ok }.resume }
  t('many breaks') { n = 0; 20_000.times { (1..3).each { n += 1; break if it == 2 } }; n }
  t('many throws') { n = 0; 5000.times { n += catch(:t) { [1].each { throw :t, 1 } } }; n }
  t('deep recursion') { f = ->(n) { n.zero? ? 0 : [1].each { return 1 + f.(n - 1) } }; f.(300) }
  t('stack overflow') { f = ->(n) { [1].map { f.(n + 1) } }; begin; f.(0); rescue SystemStackError; :sse; end } if IN_FIBER
  t('after stack overflow') { (1..3).map { it * 2 } }
  t('sort_by raise') { begin; [3, 1].sort_by { raise 's' }; rescue => e; e.message; end }
  t('json') { JSON.parse(JSON.generate({ 'a' => [1, { 'b' => nil }], 'c' => 'x' })) }
  t('json error') { JSON.parse('{bad') rescue :parse_error }
  t('json to_json raise') { o = Object.new; def o.to_json(*) = raise('tj'); JSON.generate([o]) }
  t('yaml') { YAML.safe_load("a: 1\nb: [1, 2]\nc: {d: x}") }
  t('yaml error') { YAML.safe_load("a: [1") rescue :yaml_error }
  t('date') { [Date.parse('2024-01-02').to_s, (Date.parse('nope') rescue :bad_date)] }
  t('gsub block raise') { begin; 'abc'.gsub(/b/) { raise 'g' }; rescue => e; e.message; end }
  t('gsub block') { 'a1b22'.gsub(/\d+/) { it.size.to_s } }
  t('scan block break') { 'a1b2'.scan(/\d/) { break it } }
  t('instance_eval raise') { begin; Object.new.instance_eval { raise 'ie' }; rescue => e; e.message; end }
  t('define_method return') { c = Class.new { define_method(:f) { [1].each { return :dm }; :no } }; c.new.f }
  t('proc return LocalJumpError') { pr = proc { return 1 }; o = Object.new; o.define_singleton_method(:f) { pr }; (pr.call rescue :lje) }
  t('object_space finalizer') { ObjectSpace.define_finalizer(Object.new, proc { raise 'fin' }); GC.start; :ok }
  t('set') { Set[[1], [1], [2]].size }
  t('string format') { format('%05.1f %s %p', 3.14159, :a, [1]) }
  t('comparable') { [1.clamp(2, 3), 'b'.between?('a', 'c'), ([1] <=> ['a'])] }
  t('timeout-free ensure') { r = []; begin; [1, 2].each { |x| begin; next if x == 1; r << x; ensure; r << :e; end }; ensure; r << :done; end; r }
  t('stringio') { io = StringIO.new("a\nb"); io.each_line.map(&:chomp) }
  t('protect via Integer') { Integer('12abc', exception: false).inspect + Integer('12').to_s }
  t('at depth') { f = ->(n) { n.zero? ? (begin; { a: 1 }.each { raise 'deep' }; rescue => e; e.message; end) : [0].map { f.(n - 1) }.first }; f.(50) }
  t('gc in block') { (1..50).map { GC.start if it % 25 == 0; 'x' * it }.last.size }
  t('gc in hash each') { h = (1..50).to_h { [it, it.to_s] }; n = 0; h.each { |k, v| GC.start if k == 25; n += v.size }; n }
  t('gc in rescue') { begin; { a: 1 }.each { raise 'x' }; rescue; GC.start; 'ok' + 'ay'; end }
  t('gc in ensure') { begin; begin; [1].each { raise 'x' }; ensure; GC.start; log << :gce; end; rescue => e; e.message; end }
  t('gc in catch') { catch(:x) { GC.start; [1].each { GC.start; throw :x, 'thrown' } } }
  t('gc in fiber') { f = Fiber.new { GC.start; a = 'fib' * 2; Fiber.yield a; GC.start; begin; raise 'x'; rescue; GC.start; a + '!'; end }; [f.resume, f.resume] }
end
suite(false)
GC.stress = true
OUT << '--- stress'
[1].each do
  t('s break') { (1..3).each { break it.to_s * 2 if it == 2 } }
  t('s raise') { begin; { a: 'v' }.each { |_, v| raise v + '!' }; rescue => e; e.message + '?'; end }
  t('s throw') { catch(:x) { [1].map { throw :x, 'a' + 'b' } } }
  t('s ensure') { r = []; begin; Mutex.new.synchronize { r << 'in'; raise 'e' }; rescue => e; r << e.message; ensure; r << 'done'; end; r }
  t('s eq') { [[1, ['a']] == [1, ['a']], { a: ['b'] }.inspect] }
  t('s require') { [require('json'), (require('nope_nope') rescue :le)] }
  t('s file') { [File.exist?(FILE), File.read(FILE).size.positive?, (File.read('/nope') rescue :enoent)] }
  t('s fiber') { f = Fiber.new { |x| y = Fiber.yield(x + 'b'); begin; raise y; rescue => e; e.message + 'd'; end }; [f.resume('a'), f.resume('c')] }
  t('s json') { JSON.parse(JSON.generate('a' => ['b', { 'c' => 'd' }])) }
  t('s sort_by') { %w[b a c].sort_by { it + 'x' } }
  t('s enumerator') { e = %w[a b].each; [e.next + '1', e.next + '2', (e.next rescue 'stop')] }
  t('s retry') { n = 0; begin; n += 1; raise 'r' * n if n < 3; 'n' * n; rescue; retry; end }
end
GC.stress = false
OUT.join("\n")
