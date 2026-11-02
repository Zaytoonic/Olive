# Mic Manager design

The app has two looks. Choose one under **App > Appearance**, or from the tray icon's menu. Settings and sound stay the same.

## Glass (`src/renderer/theme-glass.css`)
Brief: translucent, smooth and glossy, soft even lighting, pastel with iridescent highlights, minimal, focused on form, serene, gentle curves. Avoid low contrast, harsh shadows, clutter, dark colors, sharp edges and pixelation.

| Token | Value | Use |
|---|---|---|
| Ink | `#26254a` | Main text (the one dark tone, so text stays readable) |
| Soft ink | `#4f4e78` | Secondary text |
| Iris | `#6554e0` | Active buttons |
| Rose | `#cf2d68` | Muted and clipping |
| Pastels | `#d9ecfd`, `#fbe2ef`, `#dbf5ec`, `#e6ddfc` | Still background wash |
| Iridescence | `#6fd3e6`, `#8ea8f5`, `#b18cf2`, `#f09ac6` | Top card's edge, the only decorative use |

- **Type:** Segoe UI Variable, one family, sentence-case labels, tabular numbers.
- **The memorable part:** the input level as light in a glossy glass tube, inside the iridescent top card. Everything else stays quiet.
- **Translucency without blur:** semi-transparent white over one still background. Live blur costs too much CPU with graphics acceleration off.
- **Contrast:** text meets WCAG AA (4.5:1) over the darkest background it can sit on.

## Classic (`src/renderer/styles.css`)
The original dark look, following Apple's interface guidelines: clarity, deference, depth. Glass only adds rules scoped to `html[data-theme="glass"]`, so Classic is unchanged by it.

## Rolling back
- **Any time:** switch to Classic in the app. The choice is remembered.
- **Removing Glass from the code:** the git tag `before-glass-look` marks the last commit before it.
