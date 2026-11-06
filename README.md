# Tiny Images

A browser-based image compressor. Images never leave your machine — all
compression runs locally in WebAssembly.

## Features

- **JPEG** compression via MozJPEG (`@jsquash/jpeg`)
- **PNG** compression via libimagequant + oxipng (`imagequant`, `@jsquash/oxipng`)
- Drag-and-drop, batch processing (3 concurrent workers)
- Quality slider, per-file and aggregate savings stats
- Download individually or as a ZIP

## Development

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

## Architecture

- `src/main.js` — UI and the client-side compression pipeline
- `src/analytics.js` — fire-and-forget usage pings
- `api/track.js`, `api/stats.js` — Vercel serverless functions backed by
  Upstash Redis, powering the global "images compressed" counter and
  `public/dashboard.html`

### Environment variables

The API routes need an Upstash Redis instance:

```
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Without them the stats endpoint falls back to placeholder data, and the
compressor itself still works — it is entirely client-side.
