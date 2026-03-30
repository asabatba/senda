import type { TerrainMetadata } from "./types";

export function formatBounds(metadata: TerrainMetadata) {
	if (metadata.crs.kind === "projected") {
		return `${metadata.bounds.west.toFixed(0)}, ${metadata.bounds.south.toFixed(0)} -> ${metadata.bounds.east.toFixed(0)}, ${metadata.bounds.north.toFixed(0)} m`;
	}

	return `${metadata.bounds.west.toFixed(4)}, ${metadata.bounds.south.toFixed(4)} -> ${metadata.bounds.east.toFixed(4)}, ${metadata.bounds.north.toFixed(4)}`;
}

export function formatDistance(value: number) {
	return `${(value / 1000).toFixed(2)} km`;
}

export function formatCount(value: number, noun: string) {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
