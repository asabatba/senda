import "./style.css";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import { inflateBinaryAsset, resolveAssetUrl } from "./terrain/assets";
import { KEYBOARD_MOVE_CODES, TRACK_COLORS } from "./terrain/constants";
import { formatBounds, formatCount, formatDistance } from "./terrain/format";
import { parseGpxSegments } from "./terrain/gpx";
import { applyVerticalExaggeration, buildHeightArray } from "./terrain/heights";
import { buildSurfaceTexture } from "./terrain/texture";
import {
	buildLinePositions,
	computeTrackBounds,
	projectTrackSegments,
} from "./terrain/tracks";
import type {
	OrthophotoPresetId,
	TerrainMetadata,
	TerrainRuntime,
	TrackOverlay,
	TrackSegment,
} from "./terrain/types";

const ORTHOPHOTO_PRESET_STORAGE_KEY = "terrain.orthophotoPreset";
const ORTHOPHOTO_PRESET_ORDER: OrthophotoPresetId[] = ["2k", "4k", "8k"];

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
        <label class="control" data-orthophoto-control>
          <span>Orthophoto resolution</span>
          <select class="control-select" data-orthophoto-preset></select>
        </label>

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
const orthophotoControlNode = app.querySelector<HTMLElement>(
	"[data-orthophoto-control]",
);
const orthophotoPresetSelect = app.querySelector<HTMLSelectElement>(
	"[data-orthophoto-preset]",
);
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
	!orthophotoControlNode ||
	!orthophotoPresetSelect ||
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
let orthophotoSwitchInFlight = false;

function setStatus(message: string, isError = false) {
	statusNode.textContent = message;
	statusNode.classList.toggle("status-error", isError);
}

function formatPresetLabel(presetId: OrthophotoPresetId) {
	return presetId.toUpperCase();
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

function getCurrentExaggeration() {
	if (!terrainRuntime) {
		return 1;
	}

	const parsed = Number.parseFloat(exaggerationInput.value);
	return Number.isFinite(parsed) ? parsed : terrainRuntime.currentExaggeration;
}

function isValidPresetId(
	metadata: TerrainMetadata,
	value: string,
): value is OrthophotoPresetId {
	return value in metadata.orthophoto.presets;
}

function getStoredPreset(metadata: TerrainMetadata) {
	try {
		const stored = window.localStorage.getItem(ORTHOPHOTO_PRESET_STORAGE_KEY);
		if (stored && isValidPresetId(metadata, stored)) {
			return stored;
		}
	} catch {
		// Ignore storage failures in restricted browsers.
	}

	return metadata.orthophoto.defaultPreset;
}

function persistPresetSelection(presetId: OrthophotoPresetId) {
	try {
		window.localStorage.setItem(ORTHOPHOTO_PRESET_STORAGE_KEY, presetId);
	} catch {
		// Ignore storage failures in restricted browsers.
	}
}

function populateOrthophotoPresetControl(
	metadata: TerrainMetadata,
	selectedPreset: OrthophotoPresetId,
) {
	orthophotoPresetSelect.replaceChildren(
		...ORTHOPHOTO_PRESET_ORDER.map((presetId) => {
			const option = document.createElement("option");
			option.value = presetId;
			option.textContent = formatPresetLabel(presetId);
			option.disabled = !(presetId in metadata.orthophoto.presets);
			return option;
		}),
	);
	orthophotoPresetSelect.value = selectedPreset;
	orthophotoControlNode.hidden = false;
}

async function loadOrthophotoPresetPixels(
	metadata: TerrainMetadata,
	presetId: OrthophotoPresetId,
	baseUrl: string,
) {
	const preset = metadata.orthophoto.presets[presetId];
	setStatus(`Loading ${formatPresetLabel(presetId)} orthophoto imagery...`);
	const orthophotoAssetUrl = resolveAssetUrl(preset.url, baseUrl);
	const orthophotoResponse = await fetch(orthophotoAssetUrl);
	if (!orthophotoResponse.ok) {
		throw new Error(
			`Terrain orthophoto asset request failed with ${orthophotoResponse.status}.`,
		);
	}

	const compressedOrthophotoBuffer = await orthophotoResponse.arrayBuffer();
	const expectedOrthophotoByteLength = preset.width * preset.height * 4;
	const rawOrthophotoBuffer =
		preset.compression === "gzip"
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

	return new Uint8Array(rawOrthophotoBuffer);
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
	toggleButton.dataset.action = "toggle";
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

function updateStats(
	metadata: TerrainMetadata,
	currentPreset: OrthophotoPresetId,
) {
	const demSource =
		metadata.sourceFiles.length === 1
			? metadata.sourceFiles[0]
			: `${metadata.sourceFiles.length} DEM tiles`;
	sourceNode.textContent = `${demSource} + ${metadata.orthophoto.presets[currentPreset].sourceFile} (${formatPresetLabel(currentPreset)})`;
	footprintNode.textContent = `${formatDistance(metadata.sizeMeters.width)} x ${formatDistance(metadata.sizeMeters.height)}`;
	elevationRangeNode.textContent = `${metadata.elevationRange.min.toFixed(0)} m to ${metadata.elevationRange.max.toFixed(0)} m`;
	boundsNode.textContent = formatBounds(metadata);
}

async function applyOrthophotoPreset(
	presetId: OrthophotoPresetId,
	persistSelection = true,
) {
	if (!terrainRuntime || orthophotoSwitchInFlight) {
		return;
	}

	if (terrainRuntime.currentOrthophotoPreset === presetId) {
		if (persistSelection) {
			persistPresetSelection(presetId);
		}
		return;
	}

	orthophotoSwitchInFlight = true;
	orthophotoPresetSelect.disabled = true;

	try {
		const preset = terrainRuntime.metadata.orthophoto.presets[presetId];
		const orthophotoPixels = await loadOrthophotoPresetPixels(
			terrainRuntime.metadata,
			presetId,
			terrainRuntime.assetsBaseUrl,
		);
		const nextTexture = await buildSurfaceTexture(
			terrainRuntime.metadata,
			terrainRuntime.heights,
			orthophotoPixels,
			preset,
		);

		const material = terrainRuntime.mesh.material;
		const previousTexture = material.map;
		material.map = nextTexture;
		material.needsUpdate = true;
		previousTexture?.dispose();

		terrainRuntime.currentOrthophotoPreset = presetId;
		orthophotoPresetSelect.value = presetId;
		updateStats(terrainRuntime.metadata, presetId);
		if (persistSelection) {
			persistPresetSelection(presetId);
		}
		setStatus(
			`Terrain ready. ${formatPresetLabel(presetId)} orthophoto loaded; upload a GPX file to overlay a track.`,
		);
	} catch (error) {
		orthophotoPresetSelect.value = terrainRuntime.currentOrthophotoPreset;
		setStatus(
			error instanceof Error
				? error.message
				: "Orthophoto resolution switch failed.",
			true,
		);
	} finally {
		orthophotoPresetSelect.disabled = false;
		orthophotoSwitchInFlight = false;
	}
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

	setStatus("Loading terrain metadata...");
	const metadataUrl = resolveAssetUrl("data/terrain.json");
	const metadataResponse = await fetch(metadataUrl);
	if (!metadataResponse.ok) {
		throw new Error(
			`Terrain metadata request failed with ${metadataResponse.status}.`,
		);
	}
	const metadata = (await metadataResponse.json()) as TerrainMetadata;
	const selectedPreset = getStoredPreset(metadata);
	populateOrthophotoPresetControl(metadata, selectedPreset);
	orthophotoPresetSelect.disabled = true;

	setStatus("Loading terrain heightmap...");
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

	const orthophotoPixels = await loadOrthophotoPresetPixels(
		metadata,
		selectedPreset,
		metadataResponse.url,
	);

	setStatus("Preparing 3D terrain...");
	const heightCodes = new Uint16Array(rawHeightBuffer);
	const heights = buildHeightArray(heightCodes, metadata);
	const surfaceTexture = await buildSurfaceTexture(
		metadata,
		heights,
		orthophotoPixels,
		metadata.orthophoto.presets[selectedPreset],
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
		assetsBaseUrl: metadataResponse.url,
		currentExaggeration: metadata.defaultVerticalExaggeration,
		currentOrthophotoPreset: selectedPreset,
	};

	exaggerationInput.value = metadata.defaultVerticalExaggeration.toFixed(1);
	exaggerationValue.textContent = `${metadata.defaultVerticalExaggeration.toFixed(1)}x`;
	updateStats(metadata, selectedPreset);
	persistPresetSelection(selectedPreset);
	resetCamera(metadata, metadata.defaultVerticalExaggeration);
	resizeRenderer();

	controlsNode.hidden = false;
	statsNode.hidden = false;
	orthophotoPresetSelect.disabled = false;
	renderTrackList();
	setStatus(
		`Terrain ready. ${formatPresetLabel(selectedPreset)} orthophoto loaded; upload a GPX file to overlay a track.`,
	);
}

function animate() {
	const deltaSeconds = Math.min(clock.getDelta(), 0.1);
	animationHandle = window.requestAnimationFrame(animate);
	updateKeyboardNavigation(deltaSeconds);
	controls.update();
	renderer.render(scene, camera);
}

orthophotoPresetSelect.addEventListener("change", async () => {
	if (!terrainRuntime) {
		return;
	}

	const nextPreset = orthophotoPresetSelect.value;
	if (!isValidPresetId(terrainRuntime.metadata, nextPreset)) {
		orthophotoPresetSelect.value = terrainRuntime.currentOrthophotoPreset;
		return;
	}

	await applyOrthophotoPreset(nextPreset);
});

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
	setStatus(
		error instanceof Error ? error.message : "Terrain loading failed.",
		true,
	);
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
	const material = terrainRuntime?.mesh.material;
	material?.map?.dispose();
});
