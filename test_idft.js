function testIDFT(M) {
  const H = new Float64Array(M + 1);
  // lowpass filter: H = 1 for k < M/2, 0 otherwise
  for (let k = 0; k <= M; k++) {
    H[k] = k < M/2 ? 1 : 0;
  }
  const mid = 16;
  const N = 33;
  
  const kernel1 = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let sum = 0;
    for (let k = 0; k <= M; k++) {
      sum += H[k] * Math.cos(Math.PI * k * (n - mid) / M);
    }
    kernel1[n] = sum / M;
  }
  
  const kernel2 = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let sum = 0;
    for (let k = 0; k <= M; k++) {
      let weight = (k === 0 || k === M) ? 0.5 : 1;
      sum += weight * H[k] * Math.cos(Math.PI * k * (n - mid) / M);
    }
    kernel2[n] = sum / M;
  }
  console.log("Without 0.5:", kernel1[mid]);
  console.log("With 0.5:", kernel2[mid]);
}
testIDFT(255);
