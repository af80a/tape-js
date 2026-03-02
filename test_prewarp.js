function getGain(cn, cd, w_d) {
  const b0 = (1 + cn) / (1 + cd);
  const b1 = (1 - cn) / (1 + cd);
  const a1 = (1 - cd) / (1 + cd);
  
  // H(z) = (b0 + b1 z^-1) / (1 + a1 z^-1)
  // At w_d, z = exp(j w_d)
  const z_re = Math.cos(w_d);
  const z_im = -Math.sin(w_d);
  
  const num_re = b0 + b1 * z_re;
  const num_im = b1 * z_im;
  const den_re = 1 + a1 * z_re;
  const den_im = a1 * z_im;
  
  const num_mag2 = num_re * num_re + num_im * num_im;
  const den_mag2 = den_re * den_re + den_im * den_im;
  
  return Math.sqrt(num_mag2 / den_mag2);
}

const fs = 48000;
const tDen = 1 / (2 * Math.PI * 0.45 * fs); // 21.6 kHz pole
const w_d = 2 * Math.PI * 0.45; // 21.6 kHz digital freq
const cn = 1; // tNum = tDen / ... wait

const cd_old = 2 * fs * tDen;
const cd_new = 1 / Math.tan(1 / (2 * fs * tDen));

console.log("cd_old:", cd_old);
console.log("cd_new:", cd_new);
