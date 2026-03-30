import { computeDestinationWindow, isNoData } from "./geotiff-utils.mjs";

export async function buildDemRaster(
	tiles,
	mergedBounds,
	noDataValue,
	targetSize,
) {
	const mergedRaster = new Float32Array(targetSize.width * targetSize.height);
	const validMask = new Uint8Array(targetSize.width * targetSize.height);

	for (const tile of tiles) {
		const window = computeDestinationWindow(
			tile.bounds,
			mergedBounds,
			targetSize,
		);
		const raster = await tile.image.readRasters({
			interleave: true,
			width: window.width,
			height: window.height,
			fillValue: noDataValue,
			resampleMethod: "nearest",
		});

		for (let row = 0; row < window.height; row += 1) {
			const sourceOffset = row * window.width;
			const destinationOffset =
				(window.rowStart + row) * targetSize.width + window.colStart;

			for (let col = 0; col < window.width; col += 1) {
				const value = raster[sourceOffset + col];
				if (isNoData(value, noDataValue)) {
					continue;
				}

				mergedRaster[destinationOffset + col] = value;
				validMask[destinationOffset + col] = 1;
			}
		}
	}

	return {
		mergedRaster,
		validMask,
	};
}

export function encodeHeights(mergedRaster, validMask) {
	let minElevation = Number.POSITIVE_INFINITY;
	let maxElevation = Number.NEGATIVE_INFINITY;

	for (let index = 0; index < mergedRaster.length; index += 1) {
		if (!validMask[index]) {
			continue;
		}

		const value = mergedRaster[index];
		if (value < minElevation) {
			minElevation = value;
		}
		if (value > maxElevation) {
			maxElevation = value;
		}
	}

	if (!Number.isFinite(minElevation) || !Number.isFinite(maxElevation)) {
		throw new Error(
			"The merged DEM mosaic does not contain any valid elevation values.",
		);
	}

	const elevationSpan = Math.max(maxElevation - minElevation, 1e-6);
	const encodedHeights = new Uint16Array(mergedRaster.length);

	for (let index = 0; index < mergedRaster.length; index += 1) {
		if (!validMask[index]) {
			encodedHeights[index] = 0;
			continue;
		}

		const normalized = (mergedRaster[index] - minElevation) / elevationSpan;
		encodedHeights[index] = Math.min(
			65535,
			Math.max(1, Math.round(normalized * 65534) + 1),
		);
	}

	return {
		encodedHeights,
		elevationRange: {
			min: Number(minElevation.toFixed(3)),
			max: Number(maxElevation.toFixed(3)),
		},
	};
}
