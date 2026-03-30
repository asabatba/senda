# Agents

- Use `pnpm` for this repo.
- Rebuild terrain assets with `pnpm terrain:build`.
- Validate app changes with `pnpm build`.
- Source GeoTIFFs live under `data/` and are local-only; `data/` is gitignored.
- Generated browser terrain assets are written to `public/data/`.
- Keep terrain mesh resolution separate from orthophoto texture resolution.
- Do not load GeoTIFFs in the browser at runtime; preprocess them in `scripts/build-terrain.mjs`.
