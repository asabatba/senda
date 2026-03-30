import * as THREE from "three";

import { sampleHeightBilinear } from "./heights";
import type { TerrainMetadata } from "./types";

function rampColor(normalizedHeight: number) {
	const stops = [
		{ t: 0, color: [29, 54, 37] },
		{ t: 0.28, color: [72, 109, 73] },
		{ t: 0.55, color: [140, 134, 92] },
		{ t: 0.75, color: [159, 146, 119] },
		{ t: 0.92, color: [215, 213, 205] },
		{ t: 1, color: [247, 245, 240] },
	];

	for (let index = 0; index < stops.length - 1; index += 1) {
		const current = stops[index];
		const next = stops[index + 1];
		if (normalizedHeight <= next.t) {
			const span = next.t - current.t || 1;
			const local = (normalizedHeight - current.t) / span;
			return current.color.map((channel, channelIndex) =>
				Math.round(channel + (next.color[channelIndex] - channel) * local),
			);
		}
	}

	return stops.at(-1)?.color ?? [247, 245, 240];
}

function createReliefCanvas(
	heights: Float32Array,
	metadata: TerrainMetadata,
	textureWidth = metadata.width,
	textureHeight = metadata.height,
) {
	const pixelCount = textureWidth * textureHeight;
	const pixels = new Uint8Array(pixelCount * 3);
	const span = Math.max(
		metadata.elevationRange.max - metadata.elevationRange.min,
		1e-6,
	);
	const lightDirection = new THREE.Vector3(-0.35, 0.8, 0.48).normalize();

	const xScale =
		textureWidth > 1 ? (metadata.width - 1) / (textureWidth - 1) : 0;
	const yScale =
		textureHeight > 1 ? (metadata.height - 1) / (textureHeight - 1) : 0;

	for (let y = 0; y < textureHeight; y += 1) {
		const sourceY = y * yScale;
		for (let x = 0; x < textureWidth; x += 1) {
			const sourceX = x * xScale;
			const index = y * textureWidth + x;
			const heightValue = sampleHeightBilinear(
				heights,
				metadata.width,
				metadata.height,
				sourceX,
				sourceY,
			);
			const left = sampleHeightBilinear(
				heights,
				metadata.width,
				metadata.height,
				sourceX - xScale,
				sourceY,
			);
			const right = sampleHeightBilinear(
				heights,
				metadata.width,
				metadata.height,
				sourceX + xScale,
				sourceY,
			);
			const up = sampleHeightBilinear(
				heights,
				metadata.width,
				metadata.height,
				sourceX,
				sourceY - yScale,
			);
			const down = sampleHeightBilinear(
				heights,
				metadata.width,
				metadata.height,
				sourceX,
				sourceY + yScale,
			);

			const dx = right - left;
			const dz = down - up;
			const surfaceNormal = new THREE.Vector3(-dx, 28, -dz).normalize();
			const shading = THREE.MathUtils.clamp(
				surfaceNormal.dot(lightDirection),
				0.18,
				1,
			);
			const normalizedHeight = THREE.MathUtils.clamp(heightValue / span, 0, 1);
			const color = rampColor(normalizedHeight);
			const brightness = 0.55 + shading * 0.55;

			pixels[index * 3] = Math.min(255, Math.round(color[0] * brightness));
			pixels[index * 3 + 1] = Math.min(255, Math.round(color[1] * brightness));
			pixels[index * 3 + 2] = Math.min(255, Math.round(color[2] * brightness));
		}
	}

	const canvasElement = document.createElement("canvas");
	canvasElement.width = textureWidth;
	canvasElement.height = textureHeight;
	const context = canvasElement.getContext("2d");
	if (!context) {
		throw new Error("Failed to create a 2D canvas for the relief texture.");
	}

	const imageData = context.createImageData(textureWidth, textureHeight);
	for (let index = 0; index < pixelCount; index += 1) {
		imageData.data[index * 4] = pixels[index * 3];
		imageData.data[index * 4 + 1] = pixels[index * 3 + 1];
		imageData.data[index * 4 + 2] = pixels[index * 3 + 2];
		imageData.data[index * 4 + 3] = 255;
	}

	context.putImageData(imageData, 0, 0);
	return canvasElement;
}

function createCanvasFromRgbaPixels(
	pixels: Uint8Array,
	width: number,
	height: number,
	label: string,
) {
	const canvasElement = document.createElement("canvas");
	canvasElement.width = width;
	canvasElement.height = height;
	const context = canvasElement.getContext("2d");
	if (!context) {
		throw new Error(`Failed to create a 2D canvas for the ${label}.`);
	}

	const imageData = context.createImageData(width, height);
	imageData.data.set(pixels);
	context.putImageData(imageData, 0, 0);
	return canvasElement;
}

function compositeOrthophoto(
	reliefCanvas: HTMLCanvasElement,
	width: number,
	height: number,
	orthophotoPixels: Uint8Array,
) {
	const context = reliefCanvas.getContext("2d");
	if (!context) {
		throw new Error("Failed to access the relief texture canvas.");
	}

	const overlayCanvas = createCanvasFromRgbaPixels(
		orthophotoPixels,
		width,
		height,
		"orthophoto texture",
	);
	context.drawImage(overlayCanvas, 0, 0);
}

export async function buildSurfaceTexture(
	metadata: TerrainMetadata,
	heights: Float32Array,
	orthophotoPixels: Uint8Array | null,
) {
	const textureWidth = metadata.orthophotoAsset?.width ?? metadata.width;
	const textureHeight = metadata.orthophotoAsset?.height ?? metadata.height;
	const reliefCanvas = createReliefCanvas(
		heights,
		metadata,
		textureWidth,
		textureHeight,
	);
	if (orthophotoPixels) {
		compositeOrthophoto(
			reliefCanvas,
			textureWidth,
			textureHeight,
			orthophotoPixels,
		);
	}

	const texture = new THREE.CanvasTexture(reliefCanvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.needsUpdate = true;
	return texture;
}
