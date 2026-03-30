import { gzipSync } from "node:zlib";

import {
	computeDestinationWindow,
	computeSourceWindowForBounds,
	expandBounds,
	intersectBounds,
} from "./geotiff-utils.mjs";

export async function buildOrthophotoRaster(
	orthophotos,
	mergedBounds,
	targetSize,
) {
	const rgba = new Uint8Array(targetSize.width * targetSize.height * 4);
	const sourceFiles = [];
	let coverageBounds = null;

	for (const orthophoto of orthophotos) {
		const overlapBounds = intersectBounds(mergedBounds, orthophoto.bounds);
		if (!overlapBounds) {
			continue;
		}

		sourceFiles.push(orthophoto.name);
		coverageBounds = coverageBounds
			? expandBounds(coverageBounds, overlapBounds)
			: overlapBounds;

		const destinationWindow = computeDestinationWindow(
			overlapBounds,
			mergedBounds,
			targetSize,
		);
		const sourceWindow = computeSourceWindowForBounds(
			orthophoto.image,
			orthophoto.bounds,
			overlapBounds,
		);
		const rgb = await orthophoto.image.readRGB({
			window: sourceWindow,
			width: destinationWindow.width,
			height: destinationWindow.height,
			interleave: true,
			resampleMethod: "bilinear",
		});

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
	}

	if (!coverageBounds) {
		return null;
	}

	return {
		rgba,
		metadata: {
			format: "rgba8",
			compression: "gzip",
			sourceFiles,
			width: targetSize.width,
			height: targetSize.height,
			coverageBounds,
		},
	};
}

export function resizeRgbaBilinear(
	sourceRgba,
	sourceWidth,
	sourceHeight,
	targetWidth,
	targetHeight,
) {
	if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
		return new Uint8Array(sourceRgba);
	}

	const targetRgba = new Uint8Array(targetWidth * targetHeight * 4);
	const scaleX = sourceWidth / targetWidth;
	const scaleY = sourceHeight / targetHeight;

	for (let targetRow = 0; targetRow < targetHeight; targetRow += 1) {
		const sourceY = Math.min(
			sourceHeight - 1,
			Math.max(0, (targetRow + 0.5) * scaleY - 0.5),
		);
		const y0 = Math.max(0, Math.floor(sourceY));
		const y1 = Math.min(sourceHeight - 1, y0 + 1);
		const yWeight = sourceY - y0;

		for (let targetCol = 0; targetCol < targetWidth; targetCol += 1) {
			const sourceX = Math.min(
				sourceWidth - 1,
				Math.max(0, (targetCol + 0.5) * scaleX - 0.5),
			);
			const x0 = Math.max(0, Math.floor(sourceX));
			const x1 = Math.min(sourceWidth - 1, x0 + 1);
			const xWeight = sourceX - x0;
			const targetOffset = (targetRow * targetWidth + targetCol) * 4;

			for (let channel = 0; channel < 4; channel += 1) {
				const topLeft = sourceRgba[(y0 * sourceWidth + x0) * 4 + channel];
				const topRight = sourceRgba[(y0 * sourceWidth + x1) * 4 + channel];
				const bottomLeft =
					sourceRgba[(y1 * sourceWidth + x0) * 4 + channel];
				const bottomRight =
					sourceRgba[(y1 * sourceWidth + x1) * 4 + channel];
				const top = topLeft + (topRight - topLeft) * xWeight;
				const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
				targetRgba[targetOffset + channel] = Math.round(
					top + (bottom - top) * yWeight,
				);
			}
		}
	}

	return targetRgba;
}

export function encodeOrthophotoAsset(rgba, metadata, outputFile) {
	const rgbaBuffer = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
	const gzippedRgba = gzipSync(rgbaBuffer, { level: 9 });

	return {
		bytes: gzippedRgba,
		metadata: {
			url: outputFile,
			...metadata,
		},
	};
}
