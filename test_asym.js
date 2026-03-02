function oldAsym(phi, a) {
  return Math.tanh(phi) + a * phi / (1 + phi * phi);
}

function newAsym(phi, a) {
  return Math.tanh(phi + a) - Math.tanh(a);
}

const a = 0.015;
for (let phi of [-2, -1, -0.5, 0, 0.5, 1, 2]) {
  const o = oldAsym(phi, a);
  const n = newAsym(phi, a);
  console.log(`phi: ${phi}, old: ${o.toFixed(5)}, new: ${n.toFixed(5)}, diff: ${(n - o).toFixed(5)}`);
}
