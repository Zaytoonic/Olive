# Mic Manager design

The app has three looks. Choose one under **App > Appearance**, or from the tray icon's menu. Settings and sound stay the same.

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

## Dark (also `theme-glass.css`)
The Glass style in dark mode: the same forms, glossy pebbles, pearl controls and iridescence, as soft light on deep indigo. Every rule is shared with Glass, and only the token values differ.

| Token | Value | Use |
|---|---|---|
| Moonlight | `#f3f2ff` | Main text |
| Soft moonlight | `#c9c8ea` | Secondary text |
| Deep indigo | `#17162f` | Base, never pure black |
| Dusk | `#1f2c5c`, `#3b2150`, `#143d44`, `#2b2163` | Still background wash |
| Iridescence | Same as Glass | Top card's edge and the EQ curve |

## Classic (`src/renderer/styles.css`)
The original dark look, following Apple's interface guidelines: clarity, deference, depth. Glass and Dark only add rules scoped to `html[data-theme="glass"]`, so Classic is unchanged by them.

## Behaviour shared by all looks
- The EQ opens like a dropdown. It's closed by default and the choice is remembered, with its on/off switch and preset always in reach.
- A plain mouse wheel over the graph scrolls the page. Ctrl + scroll changes a band's width.

## Rolling back
- **Any time:** switch to Classic in the app. The choice is remembered.
- **Removing Glass from the code:** the git tag `before-glass-look` marks the last commit before it.
