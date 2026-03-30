import * as THREE from "three";

import { inflateBinaryAsset, resolveAssetUrl } from "./assets";
import type {
	NamedPlaceCategory,
	NamedPlaceFeature,
	NamedPlaceOverlay,
	TerrainMetadata,
} from "./types";

const FEATURE_RECORD_BYTES = 24;
const NAMED_PLACES_MAGIC = "NPL1";

const NAMED_PLACE_MARKER_SURFACE_OFFSET = 1.5;
const NAMED_PLACE_LABEL_SURFACE_OFFSET = 3.5;
const NAMED_PLACE_MAX_VISIBLE_LABELS = 32;
const NAMED_PLACE_MAX_VISIBLE_MARKERS = 140;
const NAMED_PLACE_VIEWPORT_PADDING = 0.18;
const NAMED_PLACE_CENTER_WEIGHT = 0.55;
const NAMED_PLACE_DISTANCE_WEIGHT = 0.45;
const HIDDEN_MARKER_POSITION = 1e9;

const CATEGORY_BY_ID: NamedPlaceCategory[] = [
	"hydrography",
	"landform",
	"protectedSite",
];

const CATEGORY_MARKER_SIZE: Record<NamedPlaceCategory, number> = {
	hydrography: 10,
	landform: 10,
	protectedSite: 12,
};

type ProjectedCandidate = {
	featureIndex: number;
	category: NamedPlaceCategory;
	projectedX: number;
	projectedY: number;
	distanceSquared: number;
	score: number;
	markerY: number;
};

const cameraPosition = new THREE.Vector3();
const featurePosition = new THREE.Vector3();
const projected = new THREE.Vector3();
const terrainCenter = new THREE.Vector3(0, 0, 0);

function getLocalFeatureHeight(
	feature: NamedPlaceFeature,
	baseElevation: number,
) {
	return feature.y - baseElevation;
}

function decodeUtf8(bytes: Uint8Array) {
	return new TextDecoder().decode(bytes);
}

export async function loadNamedPlaceFeatures(
	metadata: TerrainMetadata,
	baseUrl: string,
) {
	if (!metadata.namedPlaces) {
		return [];
	}

	const assetUrl = resolveAssetUrl(metadata.namedPlaces.url, baseUrl);
	const response = await fetch(assetUrl);
	if (!response.ok) {
		throw new Error(
			`Named-place asset request failed with ${response.status}.`,
		);
	}

	const compressedBuffer = await response.arrayBuffer();
	const rawBuffer =
		metadata.namedPlaces.compression === "gzip"
			? await inflateBinaryAsset(
					new Uint8Array(compressedBuffer),
					0,
					"Named-place asset",
				)
			: compressedBuffer;

	return decodeNamedPlaceBuffer(rawBuffer);
}

export function decodeNamedPlaceBuffer(buffer: ArrayBuffer) {
	const bytes = new Uint8Array(buffer);
	if (bytes.byteLength < 16) {
		throw new Error("Named-place asset is too small.");
	}

	const magic = decodeUtf8(bytes.subarray(0, 4));
	if (magic !== NAMED_PLACES_MAGIC) {
		throw new Error(`Named-place asset magic is ${magic}, expected NPL1.`);
	}

	const view = new DataView(buffer);
	const version = view.getUint32(4, true);
	if (version !== 1) {
		throw new Error(`Named-place asset version ${version} is unsupported.`);
	}

	const featureCount = view.getUint32(8, true);
	const stringCount = view.getUint32(12, true);
	let offset = 16;

	const strings: string[] = [];
	for (let index = 0; index < stringCount; index += 1) {
		const length = view.getUint32(offset, true);
		offset += 4;
		const nextOffset = offset + length;
		if (nextOffset > bytes.byteLength) {
			throw new Error("Named-place string table exceeds asset length.");
		}
		strings.push(decodeUtf8(bytes.subarray(offset, nextOffset)));
		offset = nextOffset;
	}

	const expectedLength = offset + featureCount * FEATURE_RECORD_BYTES;
	if (expectedLength !== bytes.byteLength) {
		throw new Error(
			`Named-place asset has ${bytes.byteLength} bytes, expected ${expectedLength}.`,
		);
	}

	const features: NamedPlaceFeature[] = [];
	for (let index = 0; index < featureCount; index += 1) {
		const base = offset + index * FEATURE_RECORD_BYTES;
		const nameIndex = view.getUint32(base + 12, true);
		const localTypeIndex = view.getUint32(base + 16, true);
		const categoryId = view.getUint8(base + 20);
		const category = CATEGORY_BY_ID[categoryId];
		if (!category) {
			throw new Error(`Named-place category id ${categoryId} is invalid.`);
		}

		features.push({
			x: view.getFloat32(base, true),
			y: view.getFloat32(base + 4, true),
			z: view.getFloat32(base + 8, true),
			name: strings[nameIndex] ?? "",
			localType:
				localTypeIndex === 0xffffffff
					? null
					: (strings[localTypeIndex] ?? null),
			category,
			categoryId,
		});
	}

	return features;
}

export function createNamedPlaceOverlay(
	features: NamedPlaceFeature[],
	metadata: TerrainMetadata,
	labelRoot: HTMLElement,
): NamedPlaceOverlay {
	const group = new THREE.Group();
	group.renderOrder = 14;

	const markersByCategory = {} as Record<NamedPlaceCategory, THREE.Points>;
	const markerBuffersByCategory = {} as Record<
		NamedPlaceCategory,
		Float32Array
	>;
	const featuresByCategory = {} as Record<
		NamedPlaceCategory,
		NamedPlaceFeature[]
	>;
	const labelElements: HTMLDivElement[] = [];
	const baseElevation = metadata.elevationRange.min;

	for (const category of CATEGORY_BY_ID) {
		const categoryFeatures = features.filter(
			(feature) => feature.category === category,
		);
		featuresByCategory[category] = categoryFeatures;

		const geometry = new THREE.BufferGeometry();
		const positions = new Float32Array(categoryFeatures.length * 3);
		categoryFeatures.forEach((feature, index) => {
			positions[index * 3] = feature.x;
			positions[index * 3 + 1] =
				getLocalFeatureHeight(feature, baseElevation) *
					metadata.defaultVerticalExaggeration +
				NAMED_PLACE_MARKER_SURFACE_OFFSET;
			positions[index * 3 + 2] = feature.z;
		});
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geometry.setDrawRange(0, 0);

		const material = new THREE.PointsMaterial({
			color: metadata.namedPlaces?.categories[category].color ?? "#ffffff",
			size: CATEGORY_MARKER_SIZE[category],
			sizeAttenuation: true,
			transparent: true,
			opacity: 0.95,
			depthWrite: false,
		});

		const points = new THREE.Points(geometry, material);
		points.frustumCulled = false;
		group.add(points);
		markersByCategory[category] = points;
		markerBuffersByCategory[category] = positions;
	}

	for (const feature of features) {
		const element = document.createElement("div");
		element.className = `named-place-label named-place-label-${feature.category}`;
		element.textContent = feature.name;
		element.title = feature.localType
			? `${feature.name} · ${feature.localType}`
			: feature.name;
		element.hidden = true;
		labelRoot.append(element);
		labelElements.push(element);
	}

	return {
		group,
		markersByCategory,
		markerBuffersByCategory,
		featuresByCategory,
		features,
		labelElements,
		baseElevation,
	};
}

export function updateNamedPlaceOverlay(
	overlay: NamedPlaceOverlay,
	exaggeration: number,
	camera: THREE.Camera,
	canvas: HTMLCanvasElement,
) {
	camera.getWorldPosition(cameraPosition);

	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	const viewportPadding = NAMED_PLACE_VIEWPORT_PADDING;
	const maxDistance =
		camera.position.distanceTo(terrainCenter) + Math.max(width, height);
	const maxDistanceSquared = Math.max(maxDistance * maxDistance, 1);

	const candidates: ProjectedCandidate[] = [];

	for (let index = 0; index < overlay.features.length; index += 1) {
		const feature = overlay.features[index];
		const markerY =
			getLocalFeatureHeight(feature, overlay.baseElevation) * exaggeration +
			NAMED_PLACE_MARKER_SURFACE_OFFSET;
		const labelY =
			getLocalFeatureHeight(feature, overlay.baseElevation) * exaggeration +
			NAMED_PLACE_LABEL_SURFACE_OFFSET;

		featurePosition.set(feature.x, labelY, feature.z);
		projected.copy(featurePosition).project(camera);

		if (
			projected.z < -1 ||
			projected.z > 1 ||
			projected.x < -(1 + viewportPadding) ||
			projected.x > 1 + viewportPadding ||
			projected.y < -(1 + viewportPadding) ||
			projected.y > 1 + viewportPadding
		) {
			continue;
		}

		const distanceSquared = cameraPosition.distanceToSquared(featurePosition);
		const centerOffset =
			Math.abs(projected.x) * 0.7 + Math.abs(projected.y) * 0.3;
		const normalizedDistance = Math.min(
			distanceSquared / maxDistanceSquared,
			1,
		);
		const score =
			centerOffset * NAMED_PLACE_CENTER_WEIGHT +
			normalizedDistance * NAMED_PLACE_DISTANCE_WEIGHT;

		candidates.push({
			featureIndex: index,
			category: feature.category,
			projectedX: projected.x,
			projectedY: projected.y,
			distanceSquared,
			score,
			markerY,
		});
	}

	candidates.sort((left, right) => {
		if (left.score !== right.score) {
			return left.score - right.score;
		}
		return left.distanceSquared - right.distanceSquared;
	});

	const labelLimit = Math.min(
		NAMED_PLACE_MAX_VISIBLE_LABELS,
		candidates.length,
	);
	const markerLimit = Math.min(
		NAMED_PLACE_MAX_VISIBLE_MARKERS,
		candidates.length,
	);

	const labelFeatureIndexes = new Set<number>();
	const markerCandidatesByCategory = {
		hydrography: [] as ProjectedCandidate[],
		landform: [] as ProjectedCandidate[],
		protectedSite: [] as ProjectedCandidate[],
	} satisfies Record<NamedPlaceCategory, ProjectedCandidate[]>;

	for (let index = 0; index < markerLimit; index += 1) {
		const candidate = candidates[index];
		markerCandidatesByCategory[candidate.category].push(candidate);
		if (index < labelLimit) {
			labelFeatureIndexes.add(candidate.featureIndex);
		}
	}

	for (const category of CATEGORY_BY_ID) {
		const points = overlay.markersByCategory[category];
		const attribute = points.geometry.getAttribute(
			"position",
		) as THREE.BufferAttribute;
		const buffer = overlay.markerBuffersByCategory[category];
		const visibleCandidates = markerCandidatesByCategory[category];

		for (let index = 0; index < visibleCandidates.length; index += 1) {
			const candidate = visibleCandidates[index];
			const feature = overlay.features[candidate.featureIndex];
			buffer[index * 3] = feature.x;
			buffer[index * 3 + 1] = candidate.markerY;
			buffer[index * 3 + 2] = feature.z;
		}
		for (
			let index = visibleCandidates.length * 3;
			index < buffer.length;
			index += 3
		) {
			buffer[index] = HIDDEN_MARKER_POSITION;
			buffer[index + 1] = HIDDEN_MARKER_POSITION;
			buffer[index + 2] = HIDDEN_MARKER_POSITION;
		}

		points.geometry.setDrawRange(0, visibleCandidates.length);
		attribute.needsUpdate = true;
	}

	for (let index = 0; index < overlay.features.length; index += 1) {
		overlay.labelElements[index].hidden = !labelFeatureIndexes.has(index);
	}

	for (let index = 0; index < labelLimit; index += 1) {
		const candidate = candidates[index];
		const label = overlay.labelElements[candidate.featureIndex];
		const screenX = ((candidate.projectedX + 1) / 2) * width;
		const screenY = ((1 - candidate.projectedY) / 2) * height;
		label.hidden = false;
		label.style.transform = `translate(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px)`;
	}
}

export function disposeNamedPlaceOverlay(overlay: NamedPlaceOverlay) {
	for (const points of Object.values(overlay.markersByCategory)) {
		points.geometry.dispose();
		points.material.dispose();
	}
	for (const label of overlay.labelElements) {
		label.remove();
	}
}
