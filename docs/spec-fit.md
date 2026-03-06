# Spec-Fit Notes

This project now distinguishes between two kinds of calibration:

- House calibration: the plugin's internal alignment convention.
- Spec fit: published machine behaviors that can be checked without owning the decks.

## House calibration

Current house standard:

- `0 VU = -18 dBFS RMS` sine at `15 ips`
- Nominal `1 kHz` full-chain alignment should land within about `±0.5 dB`
- `+6 VU` should compress measurably and raise distortion relative to nominal
- `30 ips` is treated as the fixed mastering curve (`17.5 µs`, AES / IEC2)

These are plugin-side operating assumptions. They are not copied from any one
hardware manual because the original machines are analog and do not define a
digital dBFS reference.

## Published anchors in use

The fit is currently anchored to these published or widely cited machine traits:

- Studer A810:
  - Professional line level around `+4 dBm`
  - Maximum output around `+24 dBm`
  - Typical magnetic reference flux values of `185 / 250 / 320 nWb/m`
  - Very low wow/flutter at `15 ips`, generally quoted around `0.04-0.05%`
- Ampex ATR-102:
  - Professional mastering-machine operating practice with selectable operating
    levels tied to reference flux (`185 / 250 / 355 / 500 nWb/m`)
  - Widely cited low wow/flutter around `0.04%` at `15 ips`
- MCI JH-24:
  - Line level around `+4 dBm`
  - Maximum output around `+26 dBm`
  - Wow/flutter around `0.04%`
  - Frequency response roughly `30 Hz - 22 kHz ±2 dB` at `15 ips`

## What is enforced in code

- NAB/IEC EQ standards are implemented directly from published time constants.
- Transport defaults are tested against pro-machine wow/flutter envelopes.
- Preset-specific internal reproduce gain lines the modeled decks up at nominal level.
- Nominal and `+6 VU` behavior is covered by generated-tone worklet tests.
- `30 ips` uses a fixed `17.5 µs` mastering EQ and is tested for nominal line-up
  plus extended high-frequency response relative to `15 ips`.

## Open gaps

Without real captures or bench measurements, these remain inferred rather than
verified against a physical machine:

- Exact THD vs level for each preset
- Odd/even harmonic balance of each electronics path
- Bias-over-frequency behavior against a particular service manual procedure
- Frequency-response fit of the full record/repro chain for one exact machine
- Machine-specific `30 ips` transport or alignment idiosyncrasies beyond the
  shared mastering-speed baseline

The current target is: "best defensible no-measurement fit", not archival
cloning of a specific serial-number machine.

## Reference links

- Studer A810 quick reference and calibration notes:
  - https://www.manualslib.com/manual/2909878/Studer-A810.html
  - https://manuals.plus/m/1896f67721c6f81dca803ba3a9b5ea91d19c367743473258a940a004cc9a36f0
- Ampex ATR-102 calibration conventions and tape operating levels:
  - https://help.uaudio.com/hc/en-us/articles/32491139365140-Ampex-ATR-102-Mastering-Tape-Recorder-Manual
- IASA TC-04 playback equalization summary (including `30 ips = 17.5 µs` AES / IEC2):
  - https://www.iasa-web.org/book/export/html/435
- Studer A810 quick reference (`30 ips` fixed to AES equalization):
  - https://manuals.plus/m/1896f67721c6f81dca803ba3a9b5ea91d19c367743473258a940a004cc9a36f0
- MCI JH-24 historical published specifications:
  - https://www.vintagedigital.com.au/mci-jh-24/
