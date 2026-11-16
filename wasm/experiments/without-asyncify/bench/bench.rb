# Workloads for Ruby with and without Asyncify, each timed in rounds, after warm-up rounds, as the median ms.
module Raindown; class Node; def initialize; end; end; end
Reader = Struct.new(:text) { def read(_) = text }
class RbWork < Raindown::Node
  class RegionSales
    attr_reader :orders, :units, :revenue

    def initialize
      @orders = 0
      @units = 0
      @revenue = 0.0
      @months = Hash.new(0.0)
    end

    def record(units, revenue, month)
      @orders += 1
      @units += units
      @revenue += revenue
      @months[month] += revenue
    end

    def best_month = @months.max_by { it[1] }[0]
  end

  def initialize(n: 0)
    @n = n
    super()
  end

  def rewrite(raindown:, **)
    regions = {}
    products = Hash.new(0.0)
    raindown.read('data/sales.csv').each_line(chomp: true) do |line|
      date, region, product, units, price = line.split(',', 5)
      next if units == 'units'

      units = units.to_i
      revenue = units * price.to_f
      (regions[region] ||= RegionSales.new).record(units, revenue, date[0, 7])
      products[product] += revenue
    end
    sales_table(regions, products)
  end

  private

  def sales_table(regions, products)
    rows = regions.sort_by { -it[1].revenue }.map do |name, sales|
      "| #{name} | #{sales.orders} | #{sales.units} | #{format('%.2f', sales.revenue)} | #{sales.best_month} |"
    end
    top = products.max_by(3) { it[1] }.map { |product, revenue| "#{product} (#{format('%.2f', revenue)})" }
    ['| Region | Orders | Units | Revenue | Best month |', '| --- | --- | --- | --- | --- |', *rows, '',
     "Top products: #{top.join(', ')} (#{@n})"].join("\n")
  end
end


TEXT = File.read(File.join(defined?(DIR) ? DIR : __dir__, 'sales.csv')).freeze
READER = Reader.new(TEXT)

def fib(n) = n < 2 ? n : fib(n - 1) + fib(n - 2)

WORKLOADS = {
  'sales node' => -> { RbWork.new(n: 1).rewrite(raindown: READER) },
  'raise/rescue x20k' => -> { 20_000.times { begin; raise ArgumentError; rescue ArgumentError; end } },
  'ensure x200k' => -> { 200_000.times { begin; 1; ensure; 2; end } },
  'Hash#each 200k' => -> { h = (1..1000).to_h { [it, it] }; 200.times { h.each { |k, v| k + v } } },
  'inject/map 200k' => -> { a = (1..1000).to_a; 200.times { a.map { it * 2 }.inject(:+) } },
  'catch/throw x20k' => -> { 20_000.times { catch(:done) { throw :done } } },
  'alloc 300k objects' => -> { 300_000.times.map { [it, it.to_s] }.size },
  'fib(24)' => -> { fib(24) },
  'gsub/scan text' => -> { 10.times { TEXT[0, 60_000].gsub(/,(\w+),/) { ",#{$1.upcase}," }.scan(/\d+\.\d\d/).size } },
  'Comparable sort_by 50k' => -> { (1..50_000).map { (it * 7919) % 50_000 }.sort_by { -it }.size },
}

times = Hash.new { |h, k| h[k] = [] }
ROUNDS = 12
WARMUP = 4
ROUNDS.times do |round|
  WORKLOADS.each do |name, work|
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    work.call
    times[name] << (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000 if round >= WARMUP
  end
end
times.each { |name, all| all.sort!; printf("%-24s %8.1f\n", name, all[all.size / 2]) }
puts "GC count #{GC.count}"
