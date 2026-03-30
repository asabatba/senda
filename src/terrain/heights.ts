import * as THREE from "three";

import type { TerrainMetadata, TerrainRuntime } from "./types";

export function decodeHeight(code: number, metadata: TerrainMetadata) {
	if (code === metadata.heightAsset.noDataCode) {
		return metadata.elevationRange.min;
	}

	const normalized = (code - 1) / 65534;
	return (
		metadata.elevationRange.min +
		normalized * (metadata.elevationRange.max - metadata.elevationRange.min)
	);
}

export function buildHeightArray(
	codes: Uint16Array,
	metadata: TerrainMetadata,
) {
	const heights = new Float32Array(codes.length);
	const baseElevation = metadata.elevationRange.min;

	for (let index = 0; index < codes.length; index += 1) {
		heights[index] = decodeHeight(codes[index], metadata) - baseElevation;
	}

	return heights;
}

export function sampleHeight(
	heights: Float32Array,
	width: number,
	height: number,
	x: number,
	y: number,
) {
	const clampedX = Math.min(width - 1, Math.max(0, x));
	const clampedY = Math.min(height - 1, Math.max(0, y));
	return heights[clampedY * width + clampedX] ?? 0;
}

export function sampleHeightBilinear(
	heights: Float32Array,
	width: number,
	height: number,
	x: number,
	y: number,
) {
	const maxX = width - 1;
	const maxY = height - 1;
	const clampedX = THREE.MathUtils.clamp(x, 0, maxX);
	const clampedY = THREE.MathUtils.clamp(y, 0, maxY);
	const x0 = Math.floor(clampedX);
	const x1 = Math.min(maxX, Math.ceil(clampedX));
	const y0 = Math.floor(clampedY);
	const y1 = Math.min(maxY, Math.ceil(clampedY));
	const tx = clampedX - x0;
	const ty = clampedY - y0;
	const top =
		sampleHeight(heights, width, height, x0, y0) * (1 - tx) +
		sampleHeight(heights, width, height, x1, y0) * tx;
	const bottom =
		sampleHeight(heights, width, height, x0, y1) * (1 - tx) +
		sampleHeight(heights, width, height, x1, y1) * tx;
	return top * (1 - ty) + bottom * ty;
}

function getRasterHeightSample(runtime: TerrainRuntime, x: number, y: number) {
	const index = y * runtime.metadata.width + x;
	if (runtime.heightCodes[index] === runtime.metadata.heightAsset.noDataCode) {
		return null;
	}

	return runtime.heights[index] ?? null;
}

export function sampleTerrainHeightAt(
	runtime: TerrainRuntime,
	x: number,
	y: number,
) {
	const maxX = runtime.metadata.width - 1;
	const maxY = runtime.metadata.height - 1;
	const clampedX = THREE.MathUtils.clamp(x, 0, maxX);
	const clampedY = THREE.MathUtils.clamp(y, 0, maxY);
	const x0 = Math.floor(clampedX);
	const x1 = Math.min(maxX, Math.ceil(clampedX));
	const y0 = Math.floor(clampedY);
	const y1 = Math.min(maxY, Math.ceil(clampedY));

	const tx = clampedX - x0;
	const ty = clampedY - y0;
	const samples = [
		{
			value: getRasterHeightSample(runtime, x0, y0),
			weight: (1 - tx) * (1 - ty),
		},
		{ value: getRasterHeightSample(runtime, x1, y0), weight: tx * (1 - ty) },
		{ value: getRasterHeightSample(runtime, x0, y1), weight: (1 - tx) * ty },
		{ value: getRasterHeightSample(runtime, x1, y1), weight: tx * ty },
	];

	let weightedHeight = 0;
	let totalWeight = 0;

	for (const sample of samples) {
		if (sample.value === null || sample.weight === 0) {
			continue;
		}

		weightedHeight += sample.value * sample.weight;
		totalWeight += sample.weight;
	}

	if (totalWeight === 0) {
		return null;
	}

	return weightedHeight / totalWeight;
}

export function applyVerticalExaggeration(
	geometry: THREE.PlaneGeometry,
	heights: Float32Array,
	factor: number,
) {
	const position = geometry.attributes.position;
	for (let index = 0; index < heights.length; index += 1) {
		position.setY(index, heights[index] * factor);
	}
	position.needsUpdate = true;
	geometry.computeVertexNormals();
}
