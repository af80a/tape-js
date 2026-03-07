# Physics Modeling Policy

This project targets physically defensible tape-machine simulation. The goal is
not an "in-house tone," not a golden baseline, and not preservation of the
current implementation for its own sake. The code should follow the strongest
available combination of published equations, service-manual data, machine
specifications, and clearly documented approximations.

## Hard Rules

- A model stays in the physical core only if it is backed by:
  - a cited equation or derivation
  - a published standard
  - a service manual or documented machine geometry/specification
  - a clearly named approximation with stated assumptions and limits
- Implementation snapshots are not evidence.
- Sonic baselines are not evidence unless they come from measured hardware
  captures with documented test conditions.
- Plugin operating-level conventions are not machine physics.
- If a physically justified change breaks an advisory or legacy test, the test
  should be updated or removed instead of forcing the model back toward the old
  behavior.

## What Tests May Enforce

- Published EQ standards such as NAB, IEC, and `30 ips = 17.5 µs` mastering EQ
- Geometric relations such as azimuth delay, azimuth sinc loss, and head-width
  or track-spacing consequences
- Analytical or standards-derived head-response behavior
- Published machine-spec ranges such as wow/flutter envelopes, where the test
  checks the range rather than a frozen waveform
- Numerical health constraints such as bounded output, finite state, and solver
  stability when those checks protect the mathematical model

## What Tests Must Not Enforce

- Golden output baselines from the current implementation
- Private solver state or internal arrays
- Required differences between alternate numerical solvers unless a physical
  justification exists
- House calibration claims such as fixed `0 VU` to dBFS mappings
- Residual-null or coloration-envelope targets that are not traceable to a
  published reference
- Coefficients or heuristics kept only because they preserve a familiar sound

## Current Reference Anchors

These published anchors are acceptable evidence for the current machine families:

- Studer A810:
  - Professional line level around `+4 dBm`
  - Maximum output around `+24 dBm`
  - Magnetic reference flux values around `185 / 250 / 320 nWb/m`
  - Very low wow/flutter at `15 ips`, commonly quoted around `0.04-0.05%`
- Ampex ATR-102:
  - Mastering-machine operating practice tied to reference flux
    (`185 / 250 / 355 / 500 nWb/m`)
  - Widely cited wow/flutter around `0.04%` at `15 ips`
- MCI JH-24:
  - Line level around `+4 dBm`
  - Maximum output around `+26 dBm`
  - Wow/flutter around `0.04%`
  - Frequency response roughly `30 Hz - 22 kHz ±2 dB` at `15 ips`

## Known Approximations To Revisit

The following areas are still approximation-heavy and should be treated as
temporary until they are re-derived or replaced with stronger references:

- Transport component weight mixes that are plausible but not yet traced to a
  specific mechanical model
- Transistor-stage asymmetry parameters that are still voicing-oriented rather
  than tied to a published circuit derivation
- Stationary hiss shaping that is not yet fit to measured deck noise spectra
- Preset-level gain normalization constants that act as plugin calibration
  rather than machine parameters

## Verification Policy

- `npm test` is the default full verification pass.
- `npm run test:worklet-physics` is the focused worklet-level integration suite
  for published and geometry-backed constraints.
- DSP or worklet changes should also run the most relevant targeted test file
  for the subsystem that changed.
- Do not reintroduce characterization snapshots or sound baselines unless they
  are explicitly marked advisory and tied to measured hardware behavior.

## Reference Links

- Studer A810 quick reference and calibration notes:
  - https://www.manualslib.com/manual/2909878/Studer-A810.html
  - https://manuals.plus/m/1896f67721c6f81dca803ba3a9b5ea91d19c367743473258a940a004cc9a36f0
- Ampex ATR-102 calibration conventions and tape operating levels:
  - https://help.uaudio.com/hc/en-us/articles/32491139365140-Ampex-ATR-102-Mastering-Tape-Recorder-Manual
- IASA TC-04 playback equalization summary, including `30 ips = 17.5 µs` AES / IEC2:
  - https://www.iasa-web.org/book/export/html/435
- MCI JH-24 historical published specifications:
  - https://www.vintagedigital.com.au/mci-jh-24/
