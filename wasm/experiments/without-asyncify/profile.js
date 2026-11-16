'use strict';

// A CPU profile's hottest functions, by the time spent in each one itself, and who calls those that show where Ruby
// jumps or allocates, from Node's --cpu-prof of a ruby.wasm whose functions have names, like one wasm-opt kept them in
// with -g:
//   node --cpu-prof --cpu-prof-dir=prof run.js ruby.wasm bench script.rb && node profile.js prof/*.cpuprofile
const fs = require('node:fs');

const profile = JSON.parse(fs.readFileSync(process.argv[2]));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parentOf = new Map();
profile.nodes.forEach((node) => (node.children || []).forEach((child) => parentOf.set(child, node)));
const name = (node) => node.callFrame.functionName || '(anonymous)';

// Microseconds sampled in each function, by the key it's given, of each sample's node.
function sampled(key) {
  const times = new Map();
  profile.samples.forEach((id, at) => {
    const found = key(byId.get(id));
    if (found) times.set(found, (times.get(found) || 0) + (profile.timeDeltas[at] || 0));
  });
  return [...times].sort((a, b) => b[1] - a[1]);
}

const total = profile.timeDeltas.reduce((sum, delta) => sum + delta, 0);
const percent = (time) => `${(time / total * 100).toFixed(1)}%`;
sampled(name).slice(0, 25).forEach(([fn, time]) => console.log(`${percent(time).padStart(6)}  ${fn}`));
for (const target of ['memset', 'dlmalloc', 'dlfree', 'rb_vm_exec']) {
  const callers = sampled((node) => name(node) === target && name(parentOf.get(node.id) || { callFrame: {} }));
  if (callers.length) console.log(`${target} <- ${callers.slice(0, 3).map(([fn, time]) => `${fn} ${percent(time)}`).join(', ')}`);
}
