# Sparkline Scale Controls Design

## Overview

Add discrete zoom controls to the ScopePanel column headers so the user can narrow or widen the y-axis range of each sparkline column independently.

## Interaction

Each column header (`Level (dB)`, `Gain Delta (dB)`, `Saturation`) gets a `–` / `+` button pair and a label showing the current span:

```
Level (dB)          Gain Delta (dB)       Saturation
[–] ±36 dB [+]      [–] ±12 dB [+]        [–] 50% [+]
```

- `+` zooms in (narrower span, disabled at minimum)
- `–` zooms out (wider span, disabled at maximum)

## Preset Tables

### Level (center = −12 dB)

| Index | Span | min | max |
|---|---|---|---|
| 0 | 72 dB | −48 | +24 |
| 1 | 36 dB | −30 | +6 |
| 2 | 18 dB | −21 | −3 |
| 3 | 9 dB | −16.5 | −7.5 |

Default: index 1 (±36 dB)

### Gain Delta (center = 0 dB)

| Index | Span | min | max |
|---|---|---|---|
| 0 | 48 dB | −24 | +24 |
| 1 | 24 dB | −12 | +12 |
| 2 | 12 dB | −6 | +6 |
| 3 | 6 dB | −3 | +3 |
| 4 | 3 dB | −1.5 | +1.5 |

Default: index 1 (±12 dB)

### Saturation (center = 0.5)

| Index | Span | min | max |
|---|---|---|---|
| 0 | 1.0 | 0 | 1 |
| 1 | 0.5 | 0.25 | 0.75 |
| 2 | 0.25 | 0.375 | 0.625 |
| 3 | 0.1 | 0.45 | 0.55 |

Default: index 0 (full 0..1)

## State

Three `scaleIndex` values (one per column) live in `useState` inside `ScopePanel`. Derived `(min, max)` passed as props to `Sparkline` in each `ScopeRow`. No store changes needed.

## Component Changes

- **`ScopePanel`** — add 3 `useState<number>` for scale indices; replace static column header labels with a `ScaleHeader` sub-component
- **`ScopeRow`** — accept `levelMin/Max`, `gainMin/Max`, `satMin/Max` props instead of hard-coded values
- **`Sparkline`** — no changes (min/max already props)
- **`graph.css`** — style the `–`/`+` buttons to match the dim header aesthetic

## Out of Scope

- X-axis (time window) zoom
- Per-sparkline independent scaling
- Persisting scale state across sessions
