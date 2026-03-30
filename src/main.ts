import "./style.css";

import { gunzipSync } from "fflate";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

type TerrainBounds = {
	west: number;
	south: number;
	east: number;
	north: number;
};

type TerrainMetadata = {
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
	orthophotoAsset: {
		url: string;
		format: "rgba8";
		compression: "gzip" | "none";
		sourceFile: string;
		width: number;
		height: number;
		coverageBounds: TerrainBounds;
	} | null;
	defaultVerticalExaggeration: number;
	overlay: {
		url: string | null;
	};
};

type TerrainRuntime = {
	mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
	geometry: THREE.PlaneGeometry;
	heights: Float32Array;
	heightCodes: Uint16Array;
	metadata: TerrainMetadata;
	currentExaggeration: number;
};

type TrackPoint = {
	lon: number;
	lat: number;
	ele: number | null;
};

type TrackSegment = {
	points: TrackPoint[];
};

type ProjectedTrackPoint = {
	x: number;
	z: number;
	terrainHeight: number;
};

type ProjectedTrackSegment = {
	points: ProjectedTrackPoint[];
};

type TrackOverlay = {
	id: string;
	name: string;
	color: string;
	visible: boolean;
	segments: ProjectedTrackSegment[];
	pointCount: number;
	segmentCount: number;
	skippedPointCount: number;
	bounds: THREE.Box3;
	object: THREE.Group;
	lines: Line2[];
};

const TRACK_COLORS = [
	"#ff8d5d",
	"#7ee081",
	"#57b8ff",
	"#ffd84d",
	"#fb83c8",
	"#c39bff",
];
const TRACK_SURFACE_OFFSET = 14;
const KEYBOARD_MOVE_CODES = new Set([
	"KeyW",
	"KeyA",
	"KeyS",
	"KeyD",
	"KeyQ",
	"KeyE",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"PageUp",
	"PageDown",
	"ShiftLeft",
	"ShiftRight",
]);
const GRS80_A = 6378137.0;
const GRS80_F = 1 / 298.257222101;
const UTM_K0 = 0.9996;
const UTM31_CENTRAL_MERIDIAN = ((31 - 1) * 6 - 180 + 3) * (Math.PI / 180);

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
	throw new Error("Application root was not found.");
}

app.innerHTML = `
  <div class="layout">
    <section class="viewer-shell">
      <canvas class="viewer" aria-label="3D terrain viewer"></canvas>
      <div class="viewer-overlay"></div>
      <div class="viewer-hint">
        <strong>Keyboard</strong>
        <span>WASD or arrows to move, Q/E or PgUp/PgDn for altitude, Shift to accelerate.</span>
      </div>
    </section>
    <aside class="panel">
      <p class="eyebrow">Pyrenees DEM + PNOA</p>
      <h1>Terrain Viewer</h1>
      <p class="lede">
        Preprocessed DEM heights and PNOA orthophoto imagery are draped into lightweight browser assets for fast interactive exploration.
      </p>

      <p class="status" data-status>Loading terrain assets...</p>

      <div class="controls" data-controls hidden>
        <label class="control">
          <span>Vertical exaggeration</span>
          <input type="range" min="0.8" max="3.2" step="0.1" data-exaggeration />
          <strong data-exaggeration-value></strong>
        </label>

        <div class="upload-block">
          <label class="upload-label" for="gpx-upload">Upload GPX tracks</label>
          <input class="file-input" id="gpx-upload" type="file" accept=".gpx,application/gpx+xml" multiple data-gpx-input />
          <p class="upload-copy">Tracks stay local to the browser and are clamped to the terrain surface.</p>
        </div>

        <p class="track-feedback" data-track-feedback hidden></p>

        <section class="track-section">
          <div class="track-heading">
            <span>Track overlays</span>
            <strong data-track-count>0</strong>
          </div>
          <p class="track-empty" data-track-empty>No GPX tracks uploaded yet.</p>
          <ul class="track-list" data-track-list></ul>
        </section>

        <button class="reset-button" type="button" data-reset-camera>Reset camera</button>
      </div>

      <dl class="stats" data-stats hidden>
        <div>
          <dt>Source</dt>
          <dd data-source></dd>
        </div>
        <div>
          <dt>Footprint</dt>
          <dd data-footprint></dd>
        </div>
        <div>
          <dt>Elevation</dt>
          <dd data-elevation-range></dd>
        </div>
        <div>
          <dt>Bounds</dt>
          <dd data-bounds></dd>
        </div>
      </dl>
    </aside>
  </div>
`;

const canvas = app.querySelector<HTMLCanvasElement>("canvas.viewer");
const statusNode = app.querySelector<HTMLElement>("[data-status]");
const controlsNode = app.querySelector<HTMLElement>("[data-controls]");
const statsNode = app.querySelector<HTMLElement>("[data-stats]");
const exaggerationInput = app.querySelector<HTMLInputElement>(
	"[data-exaggeration]",
);
const exaggerationValue = app.querySelector<HTMLElement>(
	"[data-exaggeration-value]",
);
const resetButton = app.querySelector<HTMLButtonElement>("[data-reset-camera]");
const gpxInput = app.querySelector<HTMLInputElement>("[data-gpx-input]");
const trackFeedbackNode = app.querySelector<HTMLElement>(
	"[data-track-feedback]",
);
const trackCountNode = app.querySelector<HTMLElement>("[data-track-count]");
const trackEmptyNode = app.querySelector<HTMLElement>("[data-track-empty]");
const trackListNode = app.querySelector<HTMLUListElement>("[data-track-list]");
const sourceNode = app.querySelector<HTMLElement>("[data-source]");
const footprintNode = app.querySelector<HTMLElement>("[data-footprint]");
const elevationRangeNode = app.querySelector<HTMLElement>(
	"[data-elevation-range]",
);
const boundsNode = app.querySelector<HTMLElement>("[data-bounds]");

if (
	!canvas ||
	!statusNode ||
	!controlsNode ||
	!statsNode ||
	!exaggerationInput ||
	!exaggerationValue ||
	!resetButton ||
	!gpxInput ||
	!trackFeedbackNode ||
	!trackCountNode ||
	!trackEmptyNode ||
	!trackListNode ||
	!sourceNode ||
	!footprintNode ||
	!elevationRangeNode ||
	!boundsNode
) {
	throw new Error("The terrain viewer UI failed to initialize.");
}

const renderer = new THREE.WebGLRenderer({
	canvas,
	antialias: true,
	alpha: true,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xd8e2da, 12000, 40000);

const camera = new THREE.PerspectiveCamera(45, 1, 10, 100000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 400;

scene.add(new THREE.HemisphereLight(0xfaf3e1, 0x344533, 1.4));

const keyLight = new THREE.DirectionalLight(0xfff1d6, 1.8);
keyLight.position.set(6000, 9000, 5000);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xb8d4ff, 0.35);
rimLight.position.set(-4000, 2500, -4500);
scene.add(rimLight);

const trackOverlays: TrackOverlay[] = [];
const pressedKeys = new Set<string>();
const clock = new THREE.Clock();
const keyboardForward = new THREE.Vector3();
const keyboardRight = new THREE.Vector3();
const keyboardOffset = new THREE.Vector3();

let terrainRuntime: TerrainRuntime | null = null;
let animationHandle = 0;
let trackColorCursor = 0;

function formatBounds(metadata: TerrainMetadata) {
	if (metadata.crs.kind === "projected") {
		return `${metadata.bounds.west.toFixed(0)}, ${metadata.bounds.south.toFixed(0)} -> ${metadata.bounds.east.toFixed(0)}, ${metadata.bounds.north.toFixed(0)} m`;
	}

	return `${metadata.bounds.west.toFixed(4)}, ${metadata.bounds.south.toFixed(4)} -> ${metadata.bounds.east.toFixed(4)}, ${metadata.bounds.north.toFixed(4)}`;
}

function formatDistance(value: number) {
	return `${(value / 1000).toFixed(2)} km`;
}

function isEditableTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) {
		return false;
	}

	if (target.isContentEditable) {
		return true;
	}

	return Boolean(target.closest("input, textarea, select, button, label"));
}

function latLonToUtm31(latitude: number, longitude: number) {
	const e2 = GRS80_F * (2 - GRS80_F);
	const ep2 = e2 / (1 - e2);
	const lat = (latitude * Math.PI) / 180;
	const lon = (longitude * Math.PI) / 180;

	const sinLat = Math.sin(lat);
	const cosLat = Math.cos(lat);
	const tanLat = Math.tan(lat);
	const n = GRS80_A / Math.sqrt(1 - e2 * sinLat * sinLat);
	const t = tanLat * tanLat;
	const c = ep2 * cosLat * cosLat;
	const a = cosLat * (lon - UTM31_CENTRAL_MERIDIAN);
	const m =
		GRS80_A *
		((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * lat -
			((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) *
				Math.sin(2 * lat) +
			((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * lat) -
			((35 * e2 ** 3) / 3072) * Math.sin(6 * lat));

	const easting =
		UTM_K0 *
			n *
			(a +
				((1 - t + c) * a ** 3) / 6 +
				((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * a ** 5) / 120) +
		500000;

	const northing =
		UTM_K0 *
		(m +
			n *
				tanLat *
				(a ** 2 / 2 +
					((5 - t + 9 * c + 4 * c ** 2) * a ** 4) / 24 +
					((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * a ** 6) / 720));

	return { easting, northing };
}

function formatCount(value: number, noun: string) {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function setTrackFeedback(
	message: string | null,
	tone: "info" | "success" | "warning" | "error" = "info",
) {
	if (!message) {
		trackFeedbackNode.hidden = true;
		trackFeedbackNode.textContent = "";
		trackFeedbackNode.className = "track-feedback";
		return;
	}

	trackFeedbackNode.hidden = false;
	trackFeedbackNode.textContent = message;
	trackFeedbackNode.className = `track-feedback track-feedback-${tone}`;
}

function nextTrackColor() {
	const color = TRACK_COLORS[trackColorCursor % TRACK_COLORS.length];
	trackColorCursor += 1;
	return color;
}

function decodeHeight(code: number, metadata: TerrainMetadata) {
	if (code === metadata.heightAsset.noDataCode) {
		return metadata.elevationRange.min;
	}

	const normalized = (code - 1) / 65534;
	return (
		metadata.elevationRange.min +
		normalized * (metadata.elevationRange.max - metadata.elevationRange.min)
	);
}

function buildHeightArray(codes: Uint16Array, metadata: TerrainMetadata) {
	const heights = new Float32Array(codes.length);
	const baseElevation = metadata.elevationRange.min;

	for (let index = 0; index < codes.length; index += 1) {
		heights[index] = decodeHeight(codes[index], metadata) - baseElevation;
	}

	return heights;
}

function sampleHeight(
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

function sampleHeightBilinear(
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

function sampleTerrainHeightAt(runtime: TerrainRuntime, x: number, y: number) {
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

function applyVerticalExaggeration(
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

async function buildSurfaceTexture(
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

function getCurrentExaggeration() {
	if (!terrainRuntime) {
		return 1;
	}

	const parsed = Number.parseFloat(exaggerationInput.value);
	return Number.isFinite(parsed) ? parsed : terrainRuntime.currentExaggeration;
}

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

function projectTrackSegments(
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

function buildLinePositions(
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

function computeTrackBounds(overlay: TrackOverlay, exaggeration: number) {
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

function updateTrackMaterialsResolution() {
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;

	if (!width || !height) {
		return;
	}

	for (const overlay of trackOverlays) {
		for (const line of overlay.lines) {
			line.material.resolution.set(width, height);
		}
	}
}

function updateTrackOverlayGeometry(
	overlay: TrackOverlay,
	exaggeration: number,
) {
	overlay.lines.forEach((line, index) => {
		line.geometry.setPositions(
			buildLinePositions(overlay.segments[index], exaggeration),
		);
		line.computeLineDistances();
	});
	overlay.bounds = computeTrackBounds(overlay, exaggeration);
}

function syncTrackOverlayGeometries(exaggeration: number) {
	for (const overlay of trackOverlays) {
		updateTrackOverlayGeometry(overlay, exaggeration);
	}
}

function disposeTrackOverlay(overlay: TrackOverlay) {
	scene.remove(overlay.object);
	for (const line of overlay.lines) {
		line.geometry.dispose();
		line.material.dispose();
	}
}

function focusBox(bounds: THREE.Box3) {
	if (bounds.isEmpty()) {
		return;
	}

	const center = bounds.getCenter(new THREE.Vector3());
	const size = bounds.getSize(new THREE.Vector3());
	const radius = Math.max(size.x, size.y * 2, size.z, 600);

	controls.target.copy(center);
	camera.position.set(
		center.x,
		center.y + radius * 0.62,
		center.z + radius * 1.08,
	);
	controls.maxDistance = Math.max(controls.maxDistance, radius * 8);
	camera.far = Math.max(camera.far, radius * 16);
	camera.updateProjectionMatrix();
	controls.update();
}

function focusTrackOverlay(overlay: TrackOverlay) {
	focusBox(overlay.bounds);
}

function buildTrackListItem(overlay: TrackOverlay) {
	const item = document.createElement("li");
	item.className = "track-item";
	item.dataset.id = overlay.id;

	const header = document.createElement("div");
	header.className = "track-item-header";

	const nameWrap = document.createElement("div");
	nameWrap.className = "track-name-wrap";

	const swatch = document.createElement("span");
	swatch.className = "track-swatch";
	swatch.style.backgroundColor = overlay.color;

	const name = document.createElement("strong");
	name.className = "track-name";
	name.textContent = overlay.name;

	nameWrap.append(swatch, name);

	const meta = document.createElement("p");
	meta.className = "track-meta";
	meta.textContent = `${formatCount(overlay.segmentCount, "segment")} · ${formatCount(overlay.pointCount, "point")}`;

	if (overlay.skippedPointCount > 0) {
		const warning = document.createElement("p");
		warning.className = "track-warning";
		warning.textContent = `Skipped ${formatCount(overlay.skippedPointCount, "point")} outside the DEM.`;
		item.append(header, meta, warning);
	} else {
		item.append(header, meta);
	}

	const actions = document.createElement("div");
	actions.className = "track-actions";

	const toggleButton = document.createElement("button");
	toggleButton.type = "button";
	toggleButton.className = "track-button";
	toggleButton.dataset.action = "toggle";
	toggleButton.textContent = overlay.visible ? "Hide" : "Show";

	const zoomButton = document.createElement("button");
	zoomButton.type = "button";
	zoomButton.className = "track-button";
	zoomButton.dataset.action = "zoom";
	zoomButton.textContent = "Zoom to track";

	const removeButton = document.createElement("button");
	removeButton.type = "button";
	removeButton.className = "track-button track-button-danger";
	removeButton.dataset.action = "remove";
	removeButton.textContent = "Remove";

	actions.append(toggleButton, zoomButton, removeButton);
	header.append(nameWrap, actions);

	return item;
}

function renderTrackList() {
	trackListNode.replaceChildren(
		...trackOverlays.map((overlay) => buildTrackListItem(overlay)),
	);
	trackCountNode.textContent = String(trackOverlays.length);
	trackEmptyNode.hidden = trackOverlays.length > 0;
}

function resetCamera(metadata: TerrainMetadata, exaggeration: number) {
	const maxSpan = Math.max(
		metadata.sizeMeters.width,
		metadata.sizeMeters.height,
	);
	const verticalRange =
		(metadata.elevationRange.max - metadata.elevationRange.min) * exaggeration;

	camera.position.set(0, maxSpan * 0.42 + verticalRange * 0.8, maxSpan * 0.82);
	controls.target.set(0, verticalRange * 0.18, 0);
	controls.maxDistance = maxSpan * 3.2;
	camera.near = 10;
	camera.far = maxSpan * 8;
	camera.updateProjectionMatrix();
	controls.update();
}

function updateKeyboardNavigation(deltaSeconds: number) {
	if (!terrainRuntime || pressedKeys.size === 0) {
		return;
	}

	keyboardForward.subVectors(controls.target, camera.position);
	keyboardForward.y = 0;
	if (keyboardForward.lengthSq() < 1e-6) {
		camera.getWorldDirection(keyboardForward);
		keyboardForward.y = 0;
	}

	if (keyboardForward.lengthSq() < 1e-6) {
		return;
	}

	keyboardForward.normalize();
	keyboardRight.crossVectors(keyboardForward, camera.up).normalize();
	keyboardOffset.set(0, 0, 0);

	if (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) {
		keyboardOffset.add(keyboardForward);
	}
	if (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown")) {
		keyboardOffset.sub(keyboardForward);
	}
	if (pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight")) {
		keyboardOffset.add(keyboardRight);
	}
	if (pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft")) {
		keyboardOffset.sub(keyboardRight);
	}
	if (pressedKeys.has("KeyE") || pressedKeys.has("PageUp")) {
		keyboardOffset.y += 1;
	}
	if (pressedKeys.has("KeyQ") || pressedKeys.has("PageDown")) {
		keyboardOffset.y -= 1;
	}

	if (keyboardOffset.lengthSq() === 0) {
		return;
	}

	const viewDistance = camera.position.distanceTo(controls.target);
	const terrainSpan = Math.max(
		terrainRuntime.metadata.sizeMeters.width,
		terrainRuntime.metadata.sizeMeters.height,
	);
	const baseSpeed = THREE.MathUtils.clamp(
		viewDistance * 1.45,
		180,
		terrainSpan * 0.24,
	);
	const speedMultiplier =
		pressedKeys.has("ShiftLeft") || pressedKeys.has("ShiftRight") ? 2.5 : 1;
	const movement = keyboardOffset
		.normalize()
		.multiplyScalar(baseSpeed * speedMultiplier * deltaSeconds);

	camera.position.add(movement);
	controls.target.add(movement);
}

function resizeRenderer() {
	const { clientWidth, clientHeight } = canvas;
	if (!clientWidth || !clientHeight) {
		return;
	}

	renderer.setSize(clientWidth, clientHeight, false);
	camera.aspect = clientWidth / clientHeight;
	camera.updateProjectionMatrix();
	updateTrackMaterialsResolution();
}

function updateStats(metadata: TerrainMetadata) {
	const demSource =
		metadata.sourceFiles.length === 1
			? metadata.sourceFiles[0]
			: `${metadata.sourceFiles.length} DEM tiles`;
	sourceNode.textContent = metadata.orthophotoAsset
		? `${demSource} + ${metadata.orthophotoAsset.sourceFile}`
		: demSource;
	footprintNode.textContent = `${formatDistance(metadata.sizeMeters.width)} x ${formatDistance(metadata.sizeMeters.height)}`;
	elevationRangeNode.textContent = `${metadata.elevationRange.min.toFixed(0)} m to ${metadata.elevationRange.max.toFixed(0)} m`;
	boundsNode.textContent = formatBounds(metadata);
}

function resolveAssetUrl(assetPath: string, baseUrl = document.baseURI) {
	return new URL(assetPath, baseUrl).toString();
}

function toArrayBuffer(bytes: Uint8Array) {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
}

function isGzipPayload(bytes: Uint8Array) {
	return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function inflateBinaryAsset(
	compressedBytes: Uint8Array,
	expectedByteLength: number,
	label: string,
) {
	if (!isGzipPayload(compressedBytes)) {
		if (compressedBytes.byteLength === expectedByteLength) {
			return toArrayBuffer(compressedBytes);
		}

		throw new Error(
			`${label} is not gzip-encoded and has ${compressedBytes.byteLength} bytes, expected ${expectedByteLength}.`,
		);
	}

	if ("DecompressionStream" in globalThis) {
		try {
			const stream = new Blob([compressedBytes])
				.stream()
				.pipeThrough(new DecompressionStream("gzip"));
			return await new Response(stream).arrayBuffer();
		} catch {
			// Fall back to JS inflate for browsers/servers with inconsistent gzip handling.
		}
	}

	const decompressed = gunzipSync(compressedBytes);
	return toArrayBuffer(decompressed);
}

function getDirectChildrenByTag(parent: Element, tagName: string) {
	const normalizedTagName = tagName.toLowerCase();
	return Array.from(parent.children).filter(
		(child) => child.tagName.toLowerCase() === normalizedTagName,
	);
}

function parseTrackPoint(element: Element) {
	const lat = Number.parseFloat(element.getAttribute("lat") ?? "");
	const lon = Number.parseFloat(element.getAttribute("lon") ?? "");

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return null;
	}

	const eleElement = getDirectChildrenByTag(element, "ele")[0];
	const ele = eleElement
		? Number.parseFloat(eleElement.textContent ?? "")
		: Number.NaN;

	return {
		lat,
		lon,
		ele: Number.isFinite(ele) ? ele : null,
	};
}

function parseGpxSegments(xmlText: string) {
	const documentParser = new DOMParser();
	const xmlDocument = documentParser.parseFromString(
		xmlText,
		"application/xml",
	);
	if (xmlDocument.querySelector("parsererror")) {
		throw new Error("The GPX file is not valid XML.");
	}

	const segments: TrackSegment[] = [];

	for (const trkseg of Array.from(xmlDocument.getElementsByTagName("trkseg"))) {
		const points = getDirectChildrenByTag(trkseg, "trkpt")
			.map((pointElement) => parseTrackPoint(pointElement))
			.filter((point): point is TrackPoint => point !== null);
		if (points.length > 0) {
			segments.push({ points });
		}
	}

	for (const route of Array.from(xmlDocument.getElementsByTagName("rte"))) {
		const points = getDirectChildrenByTag(route, "rtept")
			.map((pointElement) => parseTrackPoint(pointElement))
			.filter((point): point is TrackPoint => point !== null);
		if (points.length > 0) {
			segments.push({ points });
		}
	}

	if (segments.length === 0) {
		throw new Error("The GPX file does not contain any track or route points.");
	}

	return segments;
}

function createTrackOverlay(name: string, segments: TrackSegment[]) {
	if (!terrainRuntime) {
		throw new Error("Terrain is not ready yet.");
	}

	const projected = projectTrackSegments(segments, terrainRuntime);
	if (projected.segments.length === 0) {
		throw new Error("No GPX points fall inside the DEM bounds.");
	}

	const color = nextTrackColor();
	const group = new THREE.Group();
	const lines: Line2[] = [];
	const overlay: TrackOverlay = {
		id:
			globalThis.crypto?.randomUUID?.() ??
			`${Date.now()}-${Math.round(Math.random() * 1e6)}`,
		name,
		color,
		visible: true,
		segments: projected.segments,
		pointCount: projected.pointCount,
		segmentCount: projected.segments.length,
		skippedPointCount: projected.skippedPointCount,
		bounds: new THREE.Box3(),
		object: group,
		lines,
	};

	for (const segment of overlay.segments) {
		const geometry = new LineGeometry();
		geometry.setPositions(
			buildLinePositions(segment, terrainRuntime.currentExaggeration),
		);

		const material = new LineMaterial({
			color,
			linewidth: 4,
			transparent: true,
			opacity: 0.95,
			depthWrite: false,
		});
		material.resolution.set(canvas.clientWidth, canvas.clientHeight);

		const line = new Line2(geometry, material);
		line.computeLineDistances();
		line.frustumCulled = false;
		line.renderOrder = 12;

		group.add(line);
		lines.push(line);
	}

	updateTrackOverlayGeometry(overlay, terrainRuntime.currentExaggeration);
	scene.add(group);
	trackOverlays.push(overlay);
	return overlay;
}

async function handleTrackUpload(files: FileList | null) {
	if (!terrainRuntime || !files || files.length === 0) {
		return;
	}

	const messages: string[] = [];
	let latestOverlay: TrackOverlay | null = null;
	let loadedCount = 0;

	for (const file of Array.from(files)) {
		try {
			const segments = parseGpxSegments(await file.text());
			const overlay = createTrackOverlay(file.name, segments);
			latestOverlay = overlay;
			loadedCount += 1;

			if (overlay.skippedPointCount > 0) {
				messages.push(
					`${file.name}: loaded ${formatCount(overlay.pointCount, "point")} with ${formatCount(overlay.skippedPointCount, "point")} outside the DEM.`,
				);
			}
		} catch (error) {
			messages.push(
				`${file.name}: ${error instanceof Error ? error.message : "Upload failed."}`,
			);
		}
	}

	renderTrackList();

	if (latestOverlay) {
		focusTrackOverlay(latestOverlay);
	}

	if (loadedCount === 0) {
		setTrackFeedback(messages.join(" "), "error");
	} else if (messages.length > 0) {
		setTrackFeedback(
			`Loaded ${formatCount(loadedCount, "track")}. ${messages.join(" ")}`,
			"warning",
		);
	} else {
		setTrackFeedback(`Loaded ${formatCount(loadedCount, "track")}.`, "success");
	}

	gpxInput.value = "";
}

async function loadTerrain() {
	if (window.location.protocol === "file:") {
		throw new Error(
			'Open the site through a local web server, not directly with file://. Use "npm run dev" or "npm run preview".',
		);
	}

	statusNode.textContent = "Loading terrain metadata...";
	const metadataUrl = resolveAssetUrl("data/terrain.json");
	const metadataResponse = await fetch(metadataUrl);
	if (!metadataResponse.ok) {
		throw new Error(
			`Terrain metadata request failed with ${metadataResponse.status}.`,
		);
	}
	const metadata = (await metadataResponse.json()) as TerrainMetadata;

	statusNode.textContent = "Loading terrain heightmap...";
	const heightAssetUrl = resolveAssetUrl(
		metadata.heightAsset.url,
		metadataResponse.url,
	);
	const heightResponse = await fetch(heightAssetUrl);
	if (!heightResponse.ok) {
		throw new Error(
			`Terrain height asset request failed with ${heightResponse.status}.`,
		);
	}

	const compressedHeightBuffer = await heightResponse.arrayBuffer();
	const expectedByteLength =
		metadata.width * metadata.height * Uint16Array.BYTES_PER_ELEMENT;
	const rawHeightBuffer =
		metadata.heightAsset.compression === "gzip"
			? await inflateBinaryAsset(
					new Uint8Array(compressedHeightBuffer),
					expectedByteLength,
					"Terrain height asset",
				)
			: compressedHeightBuffer;
	if (rawHeightBuffer.byteLength !== expectedByteLength) {
		throw new Error(
			`Terrain height asset has ${rawHeightBuffer.byteLength} bytes, expected ${expectedByteLength}.`,
		);
	}

	let orthophotoPixels: Uint8Array | null = null;
	if (metadata.orthophotoAsset) {
		statusNode.textContent = "Loading orthophoto imagery...";
		const orthophotoAssetUrl = resolveAssetUrl(
			metadata.orthophotoAsset.url,
			metadataResponse.url,
		);
		const orthophotoResponse = await fetch(orthophotoAssetUrl);
		if (!orthophotoResponse.ok) {
			throw new Error(
				`Terrain orthophoto asset request failed with ${orthophotoResponse.status}.`,
			);
		}

		const compressedOrthophotoBuffer = await orthophotoResponse.arrayBuffer();
		const expectedOrthophotoByteLength =
			metadata.orthophotoAsset.width * metadata.orthophotoAsset.height * 4;
		const rawOrthophotoBuffer =
			metadata.orthophotoAsset.compression === "gzip"
				? await inflateBinaryAsset(
						new Uint8Array(compressedOrthophotoBuffer),
						expectedOrthophotoByteLength,
						"Terrain orthophoto asset",
					)
				: compressedOrthophotoBuffer;

		if (rawOrthophotoBuffer.byteLength !== expectedOrthophotoByteLength) {
			throw new Error(
				`Terrain orthophoto asset has ${rawOrthophotoBuffer.byteLength} bytes, expected ${expectedOrthophotoByteLength}.`,
			);
		}

		orthophotoPixels = new Uint8Array(rawOrthophotoBuffer);
	}

	statusNode.textContent = "Preparing 3D terrain...";
	const heightCodes = new Uint16Array(rawHeightBuffer);
	const heights = buildHeightArray(heightCodes, metadata);
	const surfaceTexture = await buildSurfaceTexture(
		metadata,
		heights,
		orthophotoPixels,
	);
	const geometry = new THREE.PlaneGeometry(
		metadata.sizeMeters.width,
		metadata.sizeMeters.height,
		metadata.width - 1,
		metadata.height - 1,
	);
	geometry.rotateX(-Math.PI / 2);

	applyVerticalExaggeration(
		geometry,
		heights,
		metadata.defaultVerticalExaggeration,
	);

	const material = new THREE.MeshStandardMaterial({
		map: surfaceTexture,
		roughness: 0.96,
		metalness: 0.02,
	});

	const mesh = new THREE.Mesh(geometry, material);
	scene.add(mesh);

	terrainRuntime = {
		mesh,
		geometry,
		heights,
		heightCodes,
		metadata,
		currentExaggeration: metadata.defaultVerticalExaggeration,
	};

	exaggerationInput.value = metadata.defaultVerticalExaggeration.toFixed(1);
	exaggerationValue.textContent = `${metadata.defaultVerticalExaggeration.toFixed(1)}x`;
	updateStats(metadata);
	resetCamera(metadata, metadata.defaultVerticalExaggeration);
	resizeRenderer();

	controlsNode.hidden = false;
	statsNode.hidden = false;
	renderTrackList();
	statusNode.textContent = metadata.orthophotoAsset
		? "Terrain ready. Orthophoto imagery is draped where available; upload a GPX file to overlay a track."
		: "Terrain ready. Upload a GPX file to overlay a track.";
}

function animate() {
	const deltaSeconds = Math.min(clock.getDelta(), 0.1);
	animationHandle = window.requestAnimationFrame(animate);
	updateKeyboardNavigation(deltaSeconds);
	controls.update();
	renderer.render(scene, camera);
}

exaggerationInput.addEventListener("input", () => {
	if (!terrainRuntime) {
		return;
	}

	const exaggeration = Number.parseFloat(exaggerationInput.value);
	terrainRuntime.currentExaggeration = exaggeration;
	applyVerticalExaggeration(
		terrainRuntime.geometry,
		terrainRuntime.heights,
		exaggeration,
	);
	syncTrackOverlayGeometries(exaggeration);
	exaggerationValue.textContent = `${exaggeration.toFixed(1)}x`;
});

gpxInput.addEventListener("change", async () => {
	await handleTrackUpload(gpxInput.files);
});

trackListNode.addEventListener("click", (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return;
	}

	const action = target.dataset.action;
	if (!action) {
		return;
	}

	const item = target.closest<HTMLElement>("[data-id]");
	if (!item) {
		return;
	}

	const overlay = trackOverlays.find((entry) => entry.id === item.dataset.id);
	if (!overlay) {
		return;
	}

	if (action === "toggle") {
		overlay.visible = !overlay.visible;
		overlay.object.visible = overlay.visible;
		renderTrackList();
		return;
	}

	if (action === "zoom") {
		focusTrackOverlay(overlay);
		return;
	}

	if (action === "remove") {
		const index = trackOverlays.findIndex((entry) => entry.id === overlay.id);
		if (index >= 0) {
			disposeTrackOverlay(overlay);
			trackOverlays.splice(index, 1);
			renderTrackList();
			setTrackFeedback(`Removed ${overlay.name}.`, "info");
		}
	}
});

resetButton.addEventListener("click", () => {
	if (!terrainRuntime) {
		return;
	}

	resetCamera(terrainRuntime.metadata, getCurrentExaggeration());
});

const resizeObserver = new ResizeObserver(() => resizeRenderer());
resizeObserver.observe(canvas);
window.addEventListener("resize", resizeRenderer);
window.addEventListener("keydown", (event) => {
	if (!KEYBOARD_MOVE_CODES.has(event.code) || event.repeat) {
		return;
	}

	if (isEditableTarget(event.target)) {
		return;
	}

	pressedKeys.add(event.code);
	event.preventDefault();
});
window.addEventListener("keyup", (event) => {
	if (!KEYBOARD_MOVE_CODES.has(event.code)) {
		return;
	}

	pressedKeys.delete(event.code);
});
window.addEventListener("blur", () => {
	pressedKeys.clear();
});

loadTerrain().catch((error) => {
	statusNode.textContent =
		error instanceof Error ? error.message : "Terrain loading failed.";
	statusNode.classList.add("status-error");
});

resizeRenderer();
animate();

window.addEventListener("beforeunload", () => {
	window.cancelAnimationFrame(animationHandle);
	controls.dispose();
	renderer.dispose();
	for (const overlay of trackOverlays) {
		disposeTrackOverlay(overlay);
	}
});
