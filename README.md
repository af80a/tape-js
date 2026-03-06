# Tape Saturator

Tape Saturator is a Vite/React Web Audio app for exploring physically modeled tape coloration in the browser. It combines machine presets, stage-level controls, real-time metering, and offline rendering in a single interface.

## Features

- Real-time tape processing with an `AudioWorklet`
- Machine presets modeled after `Studer A810`, `Ampex ATR-102`, and `MCI JH-24`
- Two control surfaces: a compact macro view and a graph-based signal-flow view
- Transport controls, input/output metering, and stage-level inspection
- Offline `16x` render that downloads a processed WAV file

## Requirements

- Node.js `18+`
- npm
- A modern browser with Web Audio and `AudioWorklet` support

## Development

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Run the test suite:

```bash
npm test
```

## Usage

1. Load an audio file with the `Load Audio` button or drag and drop it into the app.
2. Switch between `Compact View` and `Graph View` depending on whether you want macro controls or stage-by-stage inspection.
3. Tweak tape speed, formula, bias, saturation, transformer drive, transport behavior, and related parameters while audio is playing.
4. Click `Process` to run an offline `16x` render and download the processed file as WAV.

## GitHub Pages Deployment

The repo includes a GitHub Actions workflow at [`/.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml) that:

- runs on pushes to `main`
- builds the app with the correct Pages base path
- uploads `dist`
- deploys to GitHub Pages

To enable it:

1. Open the repository settings on GitHub.
2. Go to `Pages`.
3. Set the source to `GitHub Actions`.
4. Push to `main` or run the workflow manually.

With the current `origin` remote (`af80a/tape-js`), the default Pages URL should be [https://af80a.github.io/tape-js/](https://af80a.github.io/tape-js/).

## Project Notes

- The app uses `Vite` for bundling and `Vitest` for tests.
- The production build emits the worklet bundle at `dist/worklets/tape-processor.js`.
- Additional DSP calibration notes live in [`docs/spec-fit.md`](./docs/spec-fit.md).
