/**
 * Encode an AudioBuffer as 16-bit PCM WAV.
 */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  let p = 0;
  const writeU8 = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  const writeU16 = (v: number) => { view.setUint16(p, v, true); p += 2; };
  const writeU32 = (v: number) => { view.setUint32(p, v, true); p += 4; };

  // RIFF header
  writeU8('RIFF');
  writeU32(36 + dataSize);
  writeU8('WAVE');

  // fmt chunk
  writeU8('fmt ');
  writeU32(16); // PCM fmt chunk size
  writeU16(1);  // audio format = PCM
  writeU16(numChannels);
  writeU32(sampleRate);
  writeU32(byteRate);
  writeU16(blockAlign);
  writeU16(16); // bits per sample

  // data chunk
  writeU8('data');
  writeU32(dataSize);

  // Interleave and write samples
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      const pcm = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
      view.setInt16(p, pcm, true);
      p += 2;
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

export function buildProcessedFileName(sourceName: string | null, suffix = 'processed-16x'): string {
  if (!sourceName) return `audio-${suffix}.wav`;
  const dot = sourceName.lastIndexOf('.');
  const base = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  return `${base}-${suffix}.wav`;
}
