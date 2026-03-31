# gpx3d2

A small terrain viewer for preprocessed DEM and orthophoto data, with GPX track overlay support and a standalone trip export mode.

## Stack

- Preact
- Three.js
- Vite
- Go terrain preprocessing

## Commands

Install dependencies:

```bash
pnpm install
```

Run the app locally:

```bash
pnpm dev
```

Build the web app:

```bash
pnpm build
```

Rebuild browser terrain assets from local source GeoTIFFs:

```bash
pnpm terrain:build
```

Create a standalone trip export:

```bash
pnpm trip:build --gpx path/to/track.gpx --images "path/to/images/*"
```

## Notes

- Source GeoTIFFs live under `data/` and are local-only.
- Generated terrain assets are written to `public/data/`.
- GeoTIFFs are preprocessed ahead of time; they are not loaded in the browser at runtime.
- Terrain mesh resolution and orthophoto texture resolution are handled separately.
