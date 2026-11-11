# Olive design

Olive is named after Zaytoon, "olive" in Arabic. The brand is clean and premium: one dark look, in `src/ui/olive.css` (HeroUI's components themed with this palette), built on clarity, deference and depth, with a single olive accent.

## Palette
| Token | Value | Use |
|---|---|---|
| Olive | `#6B7F3A` | Accent: active buttons, switches, slider fills, the icon's background |
| Light olive | `#9AAF5E` | Text and highlights on dark: focus rings, the EQ curve |
| Canvas | `#000000` | Page background |
| Surface | `#1d1c1a` | Grouped sections |
| Tile | `#2b2a27` | Controls inside sections |
| Hairline | `#3a3935` | Dividers |
| Text | `#f5f4f0` | Main text |
| Soft text | `#9c9a91` | Captions and hints |

The greys lean slightly warm to sit with the olive. Status colours stay as they were because they carry meaning: green, yellow and red for the level meter, red for muted, orange for the gate marker. The six EQ bands keep their own colours so they can be told apart.

## Icon
A minimal white olive with its pimento and one leaf, on an olive rounded square. `tools/make-icons.js` (`npm run make-icons`) draws every size.
- **Below 32 px:** no leaf, and a bigger olive, so it still reads at 16 px.
- **Muted:** a white slashed olive on red (`#d62f28`). There's no pimento or leaf, because the slash would leave fragments of them.

## Behaviour
- The EQ opens like a dropdown. It's closed by default and the choice is remembered, with its on/off switch and preset always in reach.
- A plain mouse wheel over the graph scrolls the page. Ctrl + scroll changes a band's width.

## History
The app was called Mic Manager until the rebrand; `src/main/migrate.js` moves its settings and login entry on the first run. The git tag `before-glass-look` marks the last commit before the Glass and Dark looks were added. Both were later removed.
