import type {
	Box3,
	Group,
	Mesh,
	MeshStandardMaterial,
	PlaneGeometry,
} from "three";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";

export type TerrainBounds = {
	west: number;
	south: number;
	east: number;
	north: number;
};

export type OrthophotoPresetId = "2k" | "4k" | "8k";

export type OrthophotoPresetAsset = {
	url: string;
	format: "rgba8";
	compression: "gzip" | "none";
	sourceFile: string;
	width: number;
	height: number;
	coverageBounds: TerrainBounds;
};

export type TerrainMetadata = {
	sourceFiles: string[];
	width: number;
	height: number;
	crs: {
		epsg: number;
		kind: "projected" | "geographic";
		units: "meter" | "degree";
	};
	bounds: TerrainBounds;
	sizeMeters: {
		width: number;
		height: number;
	};
	elevationRange: {
		min: number;
		max: number;
	};
	heightAsset: {
		url: string;
		format: "uint16";
		compression: "gzip" | "none";
		noDataCode: 0;
	};
	orthophoto: {
		defaultPreset: OrthophotoPresetId;
		presets: Record<OrthophotoPresetId, OrthophotoPresetAsset>;
	};
	defaultVerticalExaggeration: number;
	overlay: {
		url: string | null;
	};
};

export type TerrainRuntime = {
	mesh: Mesh<PlaneGeometry, MeshStandardMaterial>;
	geometry: PlaneGeometry;
	heights: Float32Array;
	heightCodes: Uint16Array;
	metadata: TerrainMetadata;
	assetsBaseUrl: string;
	currentExaggeration: number;
	currentOrthophotoPreset: OrthophotoPresetId;
};

export type TrackPoint = {
	lon: number;
	lat: number;
	ele: number | null;
};

export type TrackSegment = {
	points: TrackPoint[];
};

export type ProjectedTrackPoint = {
	x: number;
	z: number;
	terrainHeight: number;
};

export type ProjectedTrackSegment = {
	points: ProjectedTrackPoint[];
};

export type TrackOverlay = {
	id: string;
	name: string;
	color: string;
	visible: boolean;
	segments: ProjectedTrackSegment[];
	pointCount: number;
	segmentCount: number;
	skippedPointCount: number;
	bounds: Box3;
	object: Group;
	lines: Line2[];
};
