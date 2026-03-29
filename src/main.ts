import "./style.css";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

type TerrainMetadata = {
	sourceFile: string;
	width: number;
	height: number;
	bounds: {
		west: number;
		south: number;
		east: number;
		north: number;
	};
	sizeMeters: {
		width: number;
		height: number;
	};
	elevationRange: {
		min: number;
		max: number;
	};
	heightEncoding: {
		format: "uint16";
		noDataCode: 0;
	};
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

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
	throw new Error("Application root was not found.");
}

app.innerHTML = `
  <div class="layout">
    <section class="viewer-shell">
      <canvas class="viewer" aria-label="3D terrain viewer"></canvas>
      <div class="viewer-overlay"></div>
    </section>
    <aside class="panel">
      <p class="eyebrow">Pyrenees DEM</p>
      <h1>Terrain Viewer</h1>
      <p class="lede">
        Preprocessed from the source GeoTIFF into a lightweight height asset for fast interactive exploration.
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

const textureLoader = new THREE.TextureLoader();
const trackOverlays: TrackOverlay[] = [];

let terrainRuntime: TerrainRuntime | null = null;
let animationHandle = 0;
let trackColorCursor = 0;

function formatBounds(bounds: TerrainMetadata["bounds"]) {
	return `${bounds.west.toFixed(4)}, ${bounds.south.toFixed(4)} -> ${bounds.east.toFixed(4)}, ${bounds.north.toFixed(4)}`;
}

function formatDistance(value: number) {
	return `${(value / 1000).toFixed(2)} km`;
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
	if (code === metadata.heightEncoding.noDataCode) {
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

function getRasterHeightSample(runtime: TerrainRuntime, x: number, y: number) {
	const index = y * runtime.metadata.width + x;
	if (
		runtime.heightCodes[index] === runtime.metadata.heightEncoding.noDataCode
	) {
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

function createReliefTexture(heights: Float32Array, metadata: TerrainMetadata) {
	const pixelCount = metadata.width * metadata.height;
	const pixels = new Uint8Array(pixelCount * 3);
	const span = Math.max(
		metadata.elevationRange.max - metadata.elevationRange.min,
		1e-6,
	);
	const lightDirection = new THREE.Vector3(-0.35, 0.8, 0.48).normalize();

	for (let y = 0; y < metadata.height; y += 1) {
		for (let x = 0; x < metadata.width; x += 1) {
			const index = y * metadata.width + x;
			const heightValue = heights[index];
			const left = sampleHeight(
				heights,
				metadata.width,
				metadata.height,
				x - 1,
				y,
			);
			const right = sampleHeight(
				heights,
				metadata.width,
				metadata.height,
				x + 1,
				y,
			);
			const up = sampleHeight(
				heights,
				metadata.width,
				metadata.height,
				x,
				y - 1,
			);
			const down = sampleHeight(
				heights,
				metadata.width,
				metadata.height,
				x,
				y + 1,
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

	const texture = new THREE.DataTexture(
		pixels,
		metadata.width,
		metadata.height,
		THREE.RGBFormat,
	);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.needsUpdate = true;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.minFilter = THREE.LinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = false;
	return texture;
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
) {
	if (metadata.overlay.url) {
		const overlayTexture = await textureLoader.loadAsync(metadata.overlay.url);
		overlayTexture.colorSpace = THREE.SRGBColorSpace;
		overlayTexture.wrapS = THREE.ClampToEdgeWrapping;
		overlayTexture.wrapT = THREE.ClampToEdgeWrapping;
		overlayTexture.minFilter = THREE.LinearMipmapLinearFilter;
		overlayTexture.magFilter = THREE.LinearFilter;
		return overlayTexture;
	}

	return createReliefTexture(heights, metadata);
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
	const lonSpan = bounds.east - bounds.west;
	const latSpan = bounds.north - bounds.south;
	const normalizedX = (point.lon - bounds.west) / lonSpan;
	const normalizedY = (bounds.north - point.lat) / latSpan;

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
	sourceNode.textContent = metadata.sourceFile;
	footprintNode.textContent = `${formatDistance(metadata.sizeMeters.width)} x ${formatDistance(metadata.sizeMeters.height)}`;
	elevationRangeNode.textContent = `${metadata.elevationRange.min.toFixed(0)} m to ${metadata.elevationRange.max.toFixed(0)} m`;
	boundsNode.textContent = formatBounds(metadata.bounds);
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
	statusNode.textContent = "Loading terrain metadata...";
	const metadataResponse = await fetch("/data/terrain.json");
	if (!metadataResponse.ok) {
		throw new Error(
			`Terrain metadata request failed with ${metadataResponse.status}.`,
		);
	}
	const metadata = (await metadataResponse.json()) as TerrainMetadata;

	statusNode.textContent = "Loading terrain heightmap...";
	const heightResponse = await fetch("/data/terrain-height.u16.bin");
	if (!heightResponse.ok) {
		throw new Error(
			`Terrain height asset request failed with ${heightResponse.status}.`,
		);
	}

	const rawHeightBuffer = await heightResponse.arrayBuffer();
	const expectedByteLength =
		metadata.width * metadata.height * Uint16Array.BYTES_PER_ELEMENT;
	if (rawHeightBuffer.byteLength !== expectedByteLength) {
		throw new Error(
			`Terrain height asset has ${rawHeightBuffer.byteLength} bytes, expected ${expectedByteLength}.`,
		);
	}

	statusNode.textContent = "Preparing 3D terrain...";
	const heightCodes = new Uint16Array(rawHeightBuffer);
	const heights = buildHeightArray(heightCodes, metadata);
	const surfaceTexture = await buildSurfaceTexture(metadata, heights);
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
	statusNode.textContent =
		"Terrain ready. Upload a GPX file to overlay a track.";
}

function animate() {
	animationHandle = window.requestAnimationFrame(animate);
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
