import path from "node:path";

export const DATA_DIR = "data";
export const DEM_TILE_PATTERN = /^MDT02-ETRS89-HU31-.*\.tif$/i;
export const ORTHOPHOTO_PATTERN = /^PNOA_MA_OF_ETRS89_HU31_h25_.*\.tif$/i;
export const DEFAULT_MAX_EDGE = 1536;
export const DEFAULT_VERTICAL_EXAGGERATION = 1.0;
export const EXPECTED_EPSG = 25831;
export const EXPECTED_RESOLUTION = 2;
export const DEFAULT_ORTHOPHOTO_PRESET = "8k";
export const ORTHOPHOTO_PRESETS = [
	{ id: "2k", maxEdge: 2048 },
	{ id: "4k", maxEdge: 4096 },
	{ id: "8k", maxEdge: 8192 },
];

export const OUTPUT_DIR = path.join("public", "data");
export const OUTPUT_HEIGHTS = "terrain-height.u16.bin.gz";
export const OUTPUT_HEIGHTS_RAW = "terrain-height.u16.bin";
export const OUTPUT_METADATA = "terrain.json";

export function getOrthophotoOutputFile(presetId) {
	return `terrain-ortho-${presetId}.rgba.bin.gz`;
}
