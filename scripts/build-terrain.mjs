import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
	DEFAULT_MAX_EDGE,
	DEFAULT_TEXTURE_MAX_EDGE,
	DEFAULT_VERTICAL_EXAGGERATION,
	EXPECTED_RESOLUTION,
	OUTPUT_DIR,
	OUTPUT_HEIGHTS,
	OUTPUT_HEIGHTS_RAW,
	OUTPUT_METADATA,
	OUTPUT_ORTHO,
} from "./terrain/config.mjs";
import { buildDemRaster, encodeHeights } from "./terrain/dem.mjs";
import { discoverOrthophoto, discoverTiles } from "./terrain/discovery.mjs";
import { computeTargetSize } from "./terrain/geotiff-utils.mjs";
import { buildOrthophotoAsset } from "./terrain/orthophoto.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

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
	const textureMaxEdge = parsePositiveInt(
		process.env.TERRAIN_TEXTURE_MAX_EDGE,
		"TERRAIN_TEXTURE_MAX_EDGE",
		DEFAULT_TEXTURE_MAX_EDGE,
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
	const textureTargetSize = computeTargetSize(
		sourceWidth,
		sourceHeight,
		textureMaxEdge,
	);

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
	const orthophotoAsset = await buildOrthophotoAsset(
		orthophoto,
		mergedBounds,
		textureTargetSize,
		OUTPUT_ORTHO,
	);

	const heightBuffer = Buffer.from(
		encodedHeights.buffer,
		encodedHeights.byteOffset,
		encodedHeights.byteLength,
	);
	const gzippedHeights = gzipSync(heightBuffer, { level: 9 });

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
		orthophotoAsset: orthophotoAsset?.metadata ?? null,
		defaultVerticalExaggeration: DEFAULT_VERTICAL_EXAGGERATION,
		overlay: {
			url: null,
		},
	};

	await fs.mkdir(outputDir, { recursive: true });
	await fs.rm(path.join(outputDir, OUTPUT_HEIGHTS_RAW), { force: true });
	await fs.writeFile(path.join(outputDir, OUTPUT_HEIGHTS), gzippedHeights);
	await fs.writeFile(
		path.join(outputDir, OUTPUT_METADATA),
		`${JSON.stringify(metadata, null, 2)}\n`,
		"utf8",
	);

	if (orthophotoAsset) {
		await fs.writeFile(
			path.join(outputDir, OUTPUT_ORTHO),
			orthophotoAsset.bytes,
		);
	} else {
		await fs.rm(path.join(outputDir, OUTPUT_ORTHO), { force: true });
	}

	console.log(
		JSON.stringify(
			{
				sources: metadata.sourceFiles,
				meshWidth: metadata.width,
				meshHeight: metadata.height,
				orthophotoWidth: orthophotoAsset?.metadata.width ?? 0,
				orthophotoHeight: orthophotoAsset?.metadata.height ?? 0,
				sizeMeters: metadata.sizeMeters,
				elevationRange: metadata.elevationRange,
				gzippedHeightBytes: gzippedHeights.length,
				gzippedOrthophotoBytes: orthophotoAsset?.bytes.length ?? 0,
				orthophotoCoverageBounds:
					orthophotoAsset?.metadata.coverageBounds ?? null,
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
