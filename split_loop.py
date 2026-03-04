import re

with open('src/worklet/tape-processor.ts', 'r') as f:
    content = f.read()

# We need to find `const tapeBlock = dsp.recordOversampler.downsample(recUpsampled);`
# and split the loop there.

old_loop_split = """      const tapeBlock = dsp.recordOversampler.downsample(recUpsampled);

      // ---- PHASE 2: BASE-RATE TAPE (head, transport, noise) ----"""

new_loop_split = """      const tapeBlock = dsp.recordOversampler.downsample(recUpsampled);
      this.tapeBlocks[ch].set(tapeBlock);
    }

    // Process magnetic crosstalk between channels
    if (numChannels > 1) {
      this.crosstalk.process(this.tapeBlocks.slice(0, numChannels));
    }

    for (let ch = 0; ch < numChannels; ch++) {
      const dsp = this.channels[ch];
      const inp = input[ch];
      const out = output[ch];
      const tapeBlock = this.tapeBlocks[ch];

      // Restore fades for stereo coherence (each channel gets same crossfade)
      if (ch > 0) {
        fadeHead = initFadeHead;
        fadeTransport = initFadeTransport;
        fadeNoise = initFadeNoise;
        fadePlaybackAmp = initFadePlaybackAmp;
        fadePlaybackEQ = initFadePlaybackEQ;
        fadeOutputXfmr = initFadeOutputXfmr;
        bypassFade = initBypassFade;
      }

      // ---- PHASE 2: BASE-RATE TAPE (head, transport, noise) ----"""

content = content.replace(old_loop_split, new_loop_split)

# Now we need to remove the initial fades restore for Phase 2+ from the first loop
old_fades = """      // Restore fades for stereo coherence (each channel gets same crossfade)
      if (ch > 0) {
        fadeInputXfmr = initFadeInputXfmr;
        fadeRecordAmp = initFadeRecordAmp;
        fadeRecordEQ = initFadeRecordEQ;
        fadeHysteresis = initFadeHysteresis;
        fadeHead = initFadeHead;
        fadeTransport = initFadeTransport;
        fadeNoise = initFadeNoise;
        fadePlaybackAmp = initFadePlaybackAmp;
        fadePlaybackEQ = initFadePlaybackEQ;
        fadeOutputXfmr = initFadeOutputXfmr;
        bypassFade = initBypassFade;
      }"""

new_fades = """      // Restore fades for stereo coherence (each channel gets same crossfade)
      if (ch > 0) {
        fadeInputXfmr = initFadeInputXfmr;
        fadeRecordAmp = initFadeRecordAmp;
        fadeRecordEQ = initFadeRecordEQ;
        fadeHysteresis = initFadeHysteresis;
      }"""

content = content.replace(old_fades, new_fades)

with open('src/worklet/tape-processor.ts', 'w') as f:
    f.write(content)
