import fs from "node:fs/promises";
import path from "node:path";

import { fromFile } from "geotiff";

import {
	DATA_DIR,
	DEM_TILE_PATTERN,
	EXPECTED_EPSG,
	EXPECTED_RESOLUTION,
	ORTHOPHOTO_FILE,
} from "./config.mjs";
import {
	assertProjectedCrs,
	assertResolution,
	assertRgbOrthophoto,
	computeBounds,
	expandBounds,
	parseNoData,
} from "./geotiff-utils.mjs";

export async function discoverTiles(repoRoot) {
	const dataDir = path.resolve(repoRoot, DATA_DIR);
	const entries = await fs.readdir(dataDir);
	const tileNames = entries
		.filter((name) => DEM_TILE_PATTERN.test(name))
		.sort();

	if (tileNames.length === 0) {
		throw new Error(
			`No DEM tiles matching ${DEM_TILE_PATTERN} were found in "${DATA_DIR}".`,
		);
	}

	const tiles = [];
	let mergedBounds = null;
	let noDataValue = null;

	for (const tileName of tileNames) {
		const tilePath = path.join(dataDir, tileName);
		const image = await (await fromFile(tilePath)).getImage();

		assertProjectedCrs(image, tileName, EXPECTED_EPSG);
		assertResolution(image, tileName, EXPECTED_RESOLUTION);

		if (image.getSamplesPerPixel() !== 1) {
			throw new Error(
				`${tileName} must be single-band, received ${image.getSamplesPerPixel()} samples per pixel.`,
			);
		}

		const tileNoData = parseNoData(image);
		if (noDataValue === null) {
			noDataValue = tileNoData;
		} else if (Math.abs(tileNoData - noDataValue) > 1e-6) {
			throw new Error(
				`${tileName} uses nodata ${tileNoData}, expected ${noDataValue}.`,
			);
		}

		const bounds = computeBounds(image);
		mergedBounds = mergedBounds ? expandBounds(mergedBounds, bounds) : bounds;

		tiles.push({
			name: tileName,
			path: tilePath,
			image,
			bounds,
		});
	}

	return {
		tiles,
		mergedBounds,
		noDataValue,
	};
}

export async function discoverOrthophoto(repoRoot) {
	const dataDir = path.resolve(repoRoot, DATA_DIR);
	const orthophotoPath = path.join(dataDir, ORTHOPHOTO_FILE);

	await fs.access(orthophotoPath);

	const image = await (await fromFile(orthophotoPath)).getImage();
	assertProjectedCrs(image, ORTHOPHOTO_FILE, EXPECTED_EPSG);
	assertRgbOrthophoto(image, ORTHOPHOTO_FILE);

	return {
		name: ORTHOPHOTO_FILE,
		path: orthophotoPath,
		image,
		bounds: computeBounds(image),
	};
}
