# Pure calculation, for timing Ruby nodes with no files or waiting, to add to a vault's .raindown, with a note of ten of
# each, like <!-- RbCalc: n: 1 --><!-- :RbCalc -->, as raindown-benchmarks' notes are written.
class RbCalc < Raindown::Node
  def initialize(n: 0)
    @n = n
    super()
  end

  def rewrite
    counts = Hash.new(0)
    total = 0
    200_000.times do |i|
      counts[(i * 7919) % 97] += 1
      total += (i % 13).zero? ? i : -1
    end
    top = counts.sort_by { |key, count| [-count, key] }.first(3)
    "#{total} #{top.inspect} (#{@n})"
  end
end

# Pure method calls and integer arithmetic.
class RbFib < Raindown::Node
  def initialize(n: 0)
    @n = n
    super()
  end

  def rewrite = "#{fib(22)} (#{@n})"

  private

  def fib(n) = n < 2 ? n : fib(n - 1) + fib(n - 2)
end
