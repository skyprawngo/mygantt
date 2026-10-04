# MyGantt app icon

Based on [Lucide chart-gantt](https://lucide.dev/icons/chart-gantt), licensed under ISC.
Original SVG: https://github.com/lucide-icons/lucide/blob/main/icons/chart-gantt.svg
License: [LUCIDE-LICENSE.txt](LUCIDE-LICENSE.txt).

The original paths are retained with white strokes on the existing MyGantt blue gradient.
`app-icon.svg` is the shared source for the sidebar and SVG favicon. PNG and ICO assets are raster exports of this SVG.
To regenerate on macOS, render using `sips -s format png app-icon.svg --out /tmp/mygantt-icon.png`, then resize with Pillow (LANCZOS) to 180, 192 and 512 pixels; export ICO at 16, 32 and 48 pixels.

## iOS Home Screen

`/apple-touch-icon.png` is the explicitly linked Apple touch icon and the root-level fallback Safari can discover. It is an opaque RGB PNG at 180 × 180 pixels; iOS applies its own corner mask. The home-screen title is `MyGantt`.

To regenerate, copy `app-icon.svg` to a temporary file, change the background rectangle from `rx="9"` to `rx="0"`, render with `sips`, convert to RGB and resize to 180 × 180 with Pillow LANCZOS. Save to both `web/apple-touch-icon.png` and the previous `web/icons/app-icon-180.png` path for compatibility.
