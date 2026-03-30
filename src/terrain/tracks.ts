import * as THREE from "three";

import { TRACK_SURFACE_OFFSET } from "./constants";
import { sampleTerrainHeightAt } from "./heights";
import type {
	ProjectedTrackPoint,
	ProjectedTrackSegment,
	TerrainRuntime,
	TrackOverlay,
	TrackPoint,
	TrackSegment,
} from "./types";
import { latLonToUtm31 } from "./utm";

function projectTrackPoint(point: TrackPoint, runtime: TerrainRuntime) {
	const { bounds, sizeMeters, width, height } = runtime.metadata;
	let projectedX = point.lon;
	let projectedY = point.lat;

	if (
		runtime.metadata.crs.kind === "projected" &&
		runtime.metadata.crs.epsg === 25831
	) {
		const projectedPoint = latLonToUtm31(point.lat, point.lon);
		projectedX = projectedPoint.easting;
		projectedY = projectedPoint.northing;
	}

	const normalizedX = (projectedX - bounds.west) / (bounds.east - bounds.west);
	const normalizedY =
		(bounds.north - projectedY) / (bounds.north - bounds.south);

	if (
		normalizedX < 0 ||
		normalizedX > 1 ||
		normalizedY < 0 ||
		normalizedY > 1
	) {
		return null;
	}

	const terrainHeight = sampleTerrainHeightAt(
		runtime,
		normalizedX * (width - 1),
		normalizedY * (height - 1),
	);
	if (terrainHeight === null) {
		return null;
	}

	return {
		x: normalizedX * sizeMeters.width - sizeMeters.width / 2,
		z: normalizedY * sizeMeters.height - sizeMeters.height / 2,
		terrainHeight,
	};
}

export function projectTrackSegments(
	segments: TrackSegment[],
	runtime: TerrainRuntime,
) {
	const projectedSegments: ProjectedTrackSegment[] = [];
	let pointCount = 0;
	let skippedPointCount = 0;

	for (const segment of segments) {
		let currentSegment: ProjectedTrackPoint[] = [];

		for (const point of segment.points) {
			const projectedPoint = projectTrackPoint(point, runtime);
			if (!projectedPoint) {
				skippedPointCount += 1;
				if (currentSegment.length >= 2) {
					projectedSegments.push({ points: currentSegment });
					pointCount += currentSegment.length;
				}
				currentSegment = [];
				continue;
			}

			currentSegment.push(projectedPoint);
		}

		if (currentSegment.length >= 2) {
			projectedSegments.push({ points: currentSegment });
			pointCount += currentSegment.length;
		} else if (currentSegment.length === 1) {
			skippedPointCount += 1;
		}
	}

	return {
		segments: projectedSegments,
		pointCount,
		skippedPointCount,
	};
}

export function buildLinePositions(
	segment: ProjectedTrackSegment,
	exaggeration: number,
) {
	const positions: number[] = [];
	for (const point of segment.points) {
		positions.push(
			point.x,
			point.terrainHeight * exaggeration + TRACK_SURFACE_OFFSET,
			point.z,
		);
	}
	return positions;
}

export function computeTrackBounds(
	overlay: TrackOverlay,
	exaggeration: number,
) {
	const bounds = new THREE.Box3();
	for (const segment of overlay.segments) {
		for (const point of segment.points) {
			bounds.expandByPoint(
				new THREE.Vector3(
					point.x,
					point.terrainHeight * exaggeration + TRACK_SURFACE_OFFSET,
					point.z,
				),
			);
		}
	}
	return bounds;
}
