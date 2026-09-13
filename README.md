# Receipt Photo Booth

See `CLAUDE.md` for the full project brief (hardware, phase scope, dev workflow) and `API.md` for the local backend API.

## Status

**Working:**
- HTTPS serving via Express + mkcert so `getUserMedia()` works on the iPad (`server.js`)
- Full booth flow: shot-count select → frame select → camera → preview/retake → print-copies select → printing → scan/QR → thank you
- Multi-shot capture composited onto a frame layout via canvas (`app.js`)
- Camera zoom (crops in ~35%, matched between live preview and the actual captured photo) and a white flash animation between shots
- Real USB thermal printing (Xprinter XP-C300H) with Floyd-Steinberg dithering, tuned brightness/sharpness (`services/printer.js`)
- Duplicate-print guard: the print button disables itself and the server rejects a second `/print` call while one is already in progress, so a double-tap can't print extra copies
- Color photo upload to Cloudinary + QR code generation so guests can download their photo (`services/storage.js`); QR appears on the "scan" screen once the upload finishes

**Not done yet (see `CLAUDE.md` for why each matters):**
- Session state is in-memory only (a `Map` in `server.js`) — not persisted to SQLite yet, so a server restart or power loss loses any in-progress session
- No automatic deletion of uploaded Cloudinary photos after a retention window (7-30 days) — photos stay on Cloudinary indefinitely until removed by hand from the Media Library
- Printer readiness check is just "is the USB device file present" — no real paper-out or cover-open detection yet
- No LINE Messaging API notifications for printer errors/paper-out
- No PM2 setup to auto-start the server on Pi boot
- Admin mode (PIN, sales dashboard) not started — deferred on purpose
- Payment/QR-to-pay intentionally not built — out of scope for this phase per `CLAUDE.md`

## Target display

The primary and only display this UI is being hand-tuned for right now is:

- **iPad 11" in portrait**, viewport **820 x 1180 CSS pixels** (logical/CSS pixels, not physical -- this is what `100vw`/`100vh` actually measure on that device, regardless of its Retina pixel density).
- This also covers the 10th-gen iPad (810x1080) and iPad Pro 11" (834x1194) in portrait, since they're close enough in size to fall in the same tuned range.

`style.css` has a dedicated block for this:

```css
@media (min-width: 768px) and (max-width: 900px) and (orientation: portrait) { ... }
```

Why this needs its own block instead of relying on `clamp()` alone: on touch tablets, `.screen` is set to a fixed `height: 100dvh` with `overflow: hidden` (see the `pointer: coarse` media query in `style.css`) so the layout never scrolls -- it's meant to behave like a kiosk screen, not a webpage. That means anything that runs too tall on this exact viewport gets silently clipped instead of scrolling into view. The sizes in that block (grid widths, gaps, padding) were picked by calculating actual pixel heights at 820x1180 so every screen fits with some headroom, not just by eyeballing proportions.

If a future screen redesign changes what's stacked vertically on any screen, re-check the total height against 1180px before assuming a size "looks about right."

## Running locally

Copy `.env.example` to `.env` and fill in your Cloudinary credentials (Dashboard → look for "API Keys" / "Product Environment Credentials") before starting the server, or photo uploads/QR codes will fail silently while printing still works fine:

```sh
cp .env.example .env
npm start
```

- `http://localhost:3000` -- plain HTTP, only reachable from the Pi itself. Browsers treat `localhost` as a secure context, so the camera (`getUserMedia`) still works here without a certificate. Easiest way to test while developing.
- `https://<pi-ip>:3443` -- how the iPad reaches it over the network. Needs the mkcert certificate installed and trusted on the iPad first (see `CLAUDE.md`), otherwise the camera will be blocked.
