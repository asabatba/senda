import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
	DEFAULT_MAX_EDGE,
	DEFAULT_ORTHOPHOTO_PRESET,
	DEFAULT_VERTICAL_EXAGGERATION,
	EXPECTED_RESOLUTION,
	getOrthophotoOutputFile,
	ORTHOPHOTO_PRESETS,
	OUTPUT_DIR,
	OUTPUT_HEIGHTS,
	OUTPUT_HEIGHTS_RAW,
	OUTPUT_METADATA,
} from "./terrain/config.mjs";
import { buildDemRaster, encodeHeights } from "./terrain/dem.mjs";
import { discoverOrthophoto, discoverTiles } from "./terrain/discovery.mjs";
import { computeTargetSize } from "./terrain/geotiff-utils.mjs";
import { buildOrthophotoAsset } from "./terrain/orthophoto.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const LEGACY_ORTHOPHOTO_FILE = "terrain-ortho.rgba.bin.gz";

function parsePositiveInt(value, envName, fallback) {
	const parsed = Number.parseInt(value ?? String(fallback), 10);
	if (!Number.isFinite(parsed) || parsed < 2) {
		throw new Error(`Invalid ${envName} value "${value}".`);
	}

	return parsed;
}

async function main() {
	const maxEdge = parsePositiveInt(
		process.env.TERRAIN_MAX_EDGE,
		"TERRAIN_MAX_EDGE",
		DEFAULT_MAX_EDGE,
	);

	const outputDir = path.resolve(repoRoot, OUTPUT_DIR);
	const { tiles, mergedBounds, noDataValue } = await discoverTiles(repoRoot);
	const orthophoto = await discoverOrthophoto(repoRoot);
	const sourceWidth = Math.round(
		(mergedBounds.east - mergedBounds.west) / EXPECTED_RESOLUTION,
	);
	const sourceHeight = Math.round(
		(mergedBounds.north - mergedBounds.south) / EXPECTED_RESOLUTION,
	);
	const meshTargetSize = computeTargetSize(sourceWidth, sourceHeight, maxEdge);

	const { mergedRaster, validMask } = await buildDemRaster(
		tiles,
		mergedBounds,
		noDataValue,
		meshTargetSize,
	);
	const { encodedHeights, elevationRange } = encodeHeights(
		mergedRaster,
		validMask,
	);

	const orthophotoAssets = await Promise.all(
		ORTHOPHOTO_PRESETS.map(async (preset) => {
			const targetSize = computeTargetSize(
				sourceWidth,
				sourceHeight,
				preset.maxEdge,
			);
			const asset = await buildOrthophotoAsset(
				orthophoto,
				mergedBounds,
				targetSize,
				getOrthophotoOutputFile(preset.id),
			);
			if (!asset) {
				throw new Error(`Failed to build orthophoto preset "${preset.id}".`);
			}

			return {
				id: preset.id,
				asset,
			};
		}),
	);

	const heightBuffer = Buffer.from(
		encodedHeights.buffer,
		encodedHeights.byteOffset,
		encodedHeights.byteLength,
	);
	const gzippedHeights = gzipSync(heightBuffer, { level: 9 });

	const orthophotoPresets = Object.fromEntries(
		orthophotoAssets.map(({ id, asset }) => [id, asset.metadata]),
	);

	const metadata = {
		sourceFiles: tiles.map((tile) => tile.name),
		width: meshTargetSize.width,
		height: meshTargetSize.height,
		crs: {
			epsg: 25831,
			kind: "projected",
			units: "meter",
		},
		bounds: mergedBounds,
		sizeMeters: {
			width: mergedBounds.east - mergedBounds.west,
			height: mergedBounds.north - mergedBounds.south,
		},
		elevationRange,
		heightAsset: {
			url: OUTPUT_HEIGHTS,
			format: "uint16",
			compression: "gzip",
			noDataCode: 0,
		},
		orthophoto: {
			defaultPreset: DEFAULT_ORTHOPHOTO_PRESET,
			presets: orthophotoPresets,
		},
		defaultVerticalExaggeration: DEFAULT_VERTICAL_EXAGGERATION,
		overlay: {
			url: null,
		},
	};

	await fs.mkdir(outputDir, { recursive: true });
	await fs.rm(path.join(outputDir, OUTPUT_HEIGHTS_RAW), { force: true });
	await fs.rm(path.join(outputDir, LEGACY_ORTHOPHOTO_FILE), { force: true });
	await fs.writeFile(path.join(outputDir, OUTPUT_HEIGHTS), gzippedHeights);
	await fs.writeFile(
		path.join(outputDir, OUTPUT_METADATA),
		`${JSON.stringify(metadata, null, 2)}\n`,
		"utf8",
	);

	await Promise.all(
		orthophotoAssets.map(({ asset }) =>
			fs.writeFile(path.join(outputDir, asset.metadata.url), asset.bytes),
		),
	);

	console.log(
		JSON.stringify(
			{
				sources: metadata.sourceFiles,
				meshWidth: metadata.width,
				meshHeight: metadata.height,
				orthophotoPresets: Object.fromEntries(
					orthophotoAssets.map(({ id, asset }) => [
						id,
						{
							width: asset.metadata.width,
							height: asset.metadata.height,
							gzippedBytes: asset.bytes.length,
							coverageBounds: asset.metadata.coverageBounds,
						},
					]),
				),
				sizeMeters: metadata.sizeMeters,
				elevationRange: metadata.elevationRange,
				gzippedHeightBytes: gzippedHeights.length,
				outputDir: path.relative(repoRoot, outputDir),
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
