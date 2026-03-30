import { gzipSync } from "node:zlib";

import {
	computeDestinationWindow,
	computeSourceWindowForBounds,
	intersectBounds,
} from "./geotiff-utils.mjs";

export async function buildOrthophotoAsset(
	orthophoto,
	mergedBounds,
	targetSize,
	outputFile,
) {
	const coverageBounds = intersectBounds(mergedBounds, orthophoto.bounds);
	if (!coverageBounds) {
		return null;
	}

	const destinationWindow = computeDestinationWindow(
		coverageBounds,
		mergedBounds,
		targetSize,
	);
	const sourceWindow = computeSourceWindowForBounds(
		orthophoto.image,
		orthophoto.bounds,
		coverageBounds,
	);
	const rgb = await orthophoto.image.readRGB({
		window: sourceWindow,
		width: destinationWindow.width,
		height: destinationWindow.height,
		interleave: true,
		resampleMethod: "bilinear",
	});

	const rgba = new Uint8Array(targetSize.width * targetSize.height * 4);

	for (let row = 0; row < destinationWindow.height; row += 1) {
		const sourceOffset = row * destinationWindow.width * 3;
		const destinationOffset =
			((destinationWindow.rowStart + row) * targetSize.width +
				destinationWindow.colStart) *
			4;

		for (let col = 0; col < destinationWindow.width; col += 1) {
			const rgbOffset = sourceOffset + col * 3;
			const rgbaOffset = destinationOffset + col * 4;
			rgba[rgbaOffset] = rgb[rgbOffset];
			rgba[rgbaOffset + 1] = rgb[rgbOffset + 1];
			rgba[rgbaOffset + 2] = rgb[rgbOffset + 2];
			rgba[rgbaOffset + 3] = 255;
		}
	}

	const rgbaBuffer = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
	const gzippedRgba = gzipSync(rgbaBuffer, { level: 9 });

	return {
		bytes: gzippedRgba,
		metadata: {
			url: outputFile,
			format: "rgba8",
			compression: "gzip",
			sourceFile: orthophoto.name,
			width: targetSize.width,
			height: targetSize.height,
			coverageBounds,
		},
	};
}
