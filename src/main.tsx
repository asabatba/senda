import "./style.css";

import { signal } from "@preact/signals";
import { render } from "preact";
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
import {
	createNamedPlaceOverlay,
	disposeNamedPlaceOverlay,
	loadNamedPlaceFeatures,
	updateNamedPlaceOverlay,
} from "./terrain/named-places";
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

// ─── Constants ────────────────────────────────────────────────────────────────

const ORTHOPHOTO_PRESET_STORAGE_KEY = "terrain.orthophotoPreset";
const NAMED_PLACES_VISIBLE_STORAGE_KEY = "terrain.namedPlacesVisible";
const ORTHOPHOTO_PRESET_ORDER: OrthophotoPresetId[] = ["2k", "4k", "8k"];

// ─── Signals ──────────────────────────────────────────────────────────────────

type OrthophotoOption = {
	id: OrthophotoPresetId;
	label: string;
	disabled: boolean;
};
type TrackFeedback = {
	message: string;
	tone: "info" | "success" | "warning" | "error";
} | null;
type StatsData = {
	source: string;
	footprint: string;
	elevationRange: string;
	bounds: string;
} | null;
type NamedPlaceLegendEntry = {
	category: string;
	color: string;
	label: string;
	count: number;
};

const statusMsg = signal("Loading terrain assets...");
const statusError = signal(false);
const controlsVisible = signal(false);
const statsData = signal<StatsData>(null);
const orthophotoOptions = signal<OrthophotoOption[]>([]);
const selectedPreset = signal<OrthophotoPresetId | "">("");
const presetSelectDisabled = signal(true);
const orthophotoControlVisible = signal(false);
const exaggerationDisplay = signal("1.0x");
const exaggerationRange = signal("1.0");
const trackFeedback = signal<TrackFeedback>(null);
const trackItems = signal<TrackOverlay[]>([]);
const namedPlaceToggleVisible = signal(false);
const namedPlacesChecked = signal(true);
const namedPlaceLegendVisible = signal(false);
const namedPlaceLegend = signal<NamedPlaceLegendEntry[]>([]);
const namedPlaceLegendCount = signal(0);

// ─── Preact components ────────────────────────────────────────────────────────

function TrackListItem({ overlay }: { overlay: TrackOverlay }) {
	return (
		<li class="track-item">
			<div class="track-item-header">
				<div class="track-name-wrap">
					<span
						class="track-swatch"
						style={{ backgroundColor: overlay.color }}
					/>
					<strong class="track-name">{overlay.name}</strong>
				</div>
				<div class="track-actions">
					<button
						type="button"
						class="track-button"
						onClick={() => handleTrackToggle(overlay)}
					>
						{overlay.visible ? "Hide" : "Show"}
					</button>
					<button
						type="button"
						class="track-button"
						onClick={() => handleTrackZoom(overlay)}
					>
						Zoom to track
					</button>
					<button
						type="button"
						class="track-button track-button-danger"
						onClick={() => handleTrackRemove(overlay)}
					>
						Remove
					</button>
				</div>
			</div>
			<p class="track-meta">
				{formatCount(overlay.segmentCount, "segment")} ·{" "}
				{formatCount(overlay.pointCount, "point")}
			</p>
			{overlay.skippedPointCount > 0 && (
				<p class="track-warning">
					Skipped {formatCount(overlay.skippedPointCount, "point")} outside the
					DEM.
				</p>
			)}
		</li>
	);
}

function App() {
	const feedback = trackFeedback.value;
	const tracks = trackItems.value;
	const legend = namedPlaceLegend.value;
	const stats = statsData.value;

	return (
		<div class="layout">
			<section class="viewer-shell">
				<canvas class="viewer" aria-label="3D terrain viewer" />
				<div class="viewer-overlay" />
				<div class="viewer-hint">
					<strong>Keyboard</strong>
					<span>
						WASD or arrows to move, Q/E or PgUp/PgDn for altitude, Shift to
						accelerate.
					</span>
				</div>
			</section>
			<aside class="panel">
				<p class="eyebrow">Pyrenees DEM + PNOA</p>
				<h1>Terrain Viewer</h1>
				<p class="lede">
					Preprocessed DEM heights and PNOA orthophoto imagery are draped into
					lightweight browser assets for fast interactive exploration.
				</p>

				<p class={statusError.value ? "status status-error" : "status"}>
					{statusMsg.value}
				</p>

				<div class="controls" hidden={!controlsVisible.value}>
					{orthophotoControlVisible.value && (
						<label class="control">
							<span>Orthophoto resolution</span>
							<select
								class="control-select"
								disabled={presetSelectDisabled.value}
								value={selectedPreset.value}
								onChange={handlePresetChange}
							>
								{orthophotoOptions.value.map((opt) => (
									<option key={opt.id} value={opt.id} disabled={opt.disabled}>
										{opt.label}
									</option>
								))}
							</select>
						</label>
					)}

					<label class="control">
						<span>Vertical exaggeration</span>
						<input
							type="range"
							min="0.8"
							max="2"
							step="0.1"
							value={exaggerationRange.value}
							onInput={handleExaggerationInput}
						/>
						<strong>{exaggerationDisplay.value}</strong>
					</label>

					{namedPlaceToggleVisible.value && (
						<label class="control control-toggle">
							<span>Feature overlay</span>
							<input
								type="checkbox"
								checked={namedPlacesChecked.value}
								onChange={handleNamedPlaceToggle}
							/>
						</label>
					)}

					<div class="upload-block">
						<label class="upload-label" for="gpx-upload">
							Upload GPX tracks
						</label>
						<input
							class="file-input"
							id="gpx-upload"
							type="file"
							accept=".gpx,application/gpx+xml"
							multiple
							onChange={handleGpxChange}
						/>
						<p class="upload-copy">
							Tracks stay local to the browser and are clamped to the terrain
							surface.
						</p>
					</div>

					{feedback && (
						<p class={`track-feedback track-feedback-${feedback.tone}`}>
							{feedback.message}
						</p>
					)}

					<section class="track-section">
						<div class="track-heading">
							<span>Track overlays</span>
							<strong>{tracks.length}</strong>
						</div>
						{tracks.length === 0 ? (
							<p class="track-empty">No GPX tracks uploaded yet.</p>
						) : (
							<ul class="track-list">
								{tracks.map((overlay) => (
									<TrackListItem key={overlay.id} overlay={overlay} />
								))}
							</ul>
						)}
					</section>

					{namedPlaceLegendVisible.value && legend.length > 0 && (
						<section class="track-section">
							<div class="track-heading">
								<span>Natural features</span>
								<strong>{namedPlaceLegendCount.value}</strong>
							</div>
							<ul class="track-list named-place-legend">
								{legend.map((entry) => (
									<li
										key={entry.category}
										class="track-item named-place-legend-item"
										data-category={entry.category}
									>
										<div class="track-name-wrap">
											<span
												class="track-swatch"
												style={{ backgroundColor: entry.color }}
											/>
											<strong class="track-name">{entry.label}</strong>
										</div>
										<p class="track-meta">{entry.count} visible labels</p>
									</li>
								))}
							</ul>
						</section>
					)}

					<button
						class="reset-button"
						type="button"
						onClick={handleResetCamera}
					>
						Reset camera
					</button>
				</div>

				{stats && (
					<dl class="stats">
						<div>
							<dt>Source</dt>
							<dd>{stats.source}</dd>
						</div>
						<div>
							<dt>Footprint</dt>
							<dd>{stats.footprint}</dd>
						</div>
						<div>
							<dt>Elevation</dt>
							<dd>{stats.elevationRange}</dd>
						</div>
						<div>
							<dt>Bounds</dt>
							<dd>{stats.bounds}</dd>
						</div>
					</dl>
				)}
			</aside>
		</div>
	);
}

// ─── Three.js module-level state ──────────────────────────────────────────────

let canvas!: HTMLCanvasElement;
let viewerOverlay!: HTMLElement;
let renderer!: THREE.WebGLRenderer;
let scene!: THREE.Scene;
let camera!: THREE.PerspectiveCamera;
let controls!: OrbitControls;

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

// ─── UI callbacks (used in components) ────────────────────────────────────────

async function handlePresetChange(event: Event) {
	if (!terrainRuntime) return;
	const select = event.target as HTMLSelectElement;
	const nextPreset = select.value;
	if (!isValidPresetId(terrainRuntime.metadata, nextPreset)) {
		selectedPreset.value = terrainRuntime.currentOrthophotoPreset;
		return;
	}
	await applyOrthophotoPreset(nextPreset);
}

function handleExaggerationInput(event: Event) {
	if (!terrainRuntime) return;
	const input = event.target as HTMLInputElement;
	const exaggeration = Number.parseFloat(input.value);
	terrainRuntime.currentExaggeration = exaggeration;
	applyVerticalExaggeration(
		terrainRuntime.geometry,
		terrainRuntime.heights,
		exaggeration,
	);
	syncTrackOverlayGeometries(exaggeration);
	if (terrainRuntime.namedPlaceOverlay && terrainRuntime.namedPlacesVisible) {
		updateNamedPlaceOverlay(
			terrainRuntime.namedPlaceOverlay,
			exaggeration,
			camera,
			canvas,
		);
	}
	exaggerationRange.value = input.value;
	exaggerationDisplay.value = `${exaggeration.toFixed(1)}x`;
}

async function handleGpxChange(event: Event) {
	await handleTrackUpload((event.target as HTMLInputElement).files);
	(event.target as HTMLInputElement).value = "";
}

function handleNamedPlaceToggle(event: Event) {
	setNamedPlacesVisible((event.target as HTMLInputElement).checked);
}

function handleResetCamera() {
	if (!terrainRuntime) return;
	resetCamera(terrainRuntime.metadata, terrainRuntime.currentExaggeration);
}

function handleTrackToggle(overlay: TrackOverlay) {
	overlay.visible = !overlay.visible;
	overlay.object.visible = overlay.visible;
	trackItems.value = [...trackOverlays];
}

function handleTrackZoom(overlay: TrackOverlay) {
	focusTrackOverlay(overlay);
}

function handleTrackRemove(overlay: TrackOverlay) {
	const index = trackOverlays.findIndex((entry) => entry.id === overlay.id);
	if (index >= 0) {
		disposeTrackOverlay(overlay);
		trackOverlays.splice(index, 1);
		trackItems.value = [...trackOverlays];
		setTrackFeedback(`Removed ${overlay.name}.`, "info");
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(message: string, isError = false) {
	statusMsg.value = message;
	statusError.value = isError;
}

function setTrackFeedback(
	message: string | null,
	tone: "info" | "success" | "warning" | "error" = "info",
) {
	trackFeedback.value = message ? { message, tone } : null;
}

function formatPresetLabel(presetId: OrthophotoPresetId) {
	return presetId.toUpperCase();
}

function formatOrthophotoSourceLabel(
	metadata: TerrainMetadata,
	currentPreset: OrthophotoPresetId,
) {
	const orthophotoSources =
		metadata.orthophoto.presets[currentPreset].sourceFiles;
	return orthophotoSources.length === 1
		? orthophotoSources[0]
		: `${orthophotoSources.length} orthophotos`;
}

function isEditableTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return Boolean(target.closest("input, textarea, select, button, label"));
}

function nextTrackColor() {
	const color = TRACK_COLORS[trackColorCursor % TRACK_COLORS.length]!;
	trackColorCursor += 1;
	return color;
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
		if (stored && isValidPresetId(metadata, stored)) return stored;
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

function getStoredNamedPlacesVisible() {
	try {
		const stored = window.localStorage.getItem(
			NAMED_PLACES_VISIBLE_STORAGE_KEY,
		);
		if (stored === "true") return true;
		if (stored === "false") return false;
	} catch {
		// Ignore storage failures in restricted browsers.
	}
	return true;
}

function persistNamedPlacesVisible(value: boolean) {
	try {
		window.localStorage.setItem(
			NAMED_PLACES_VISIBLE_STORAGE_KEY,
			String(value),
		);
	} catch {
		// Ignore storage failures in restricted browsers.
	}
}

function populateOrthophotoPresetControl(
	metadata: TerrainMetadata,
	currentPreset: OrthophotoPresetId,
) {
	orthophotoOptions.value = ORTHOPHOTO_PRESET_ORDER.map((presetId) => ({
		id: presetId,
		label: formatPresetLabel(presetId),
		disabled: !(presetId in metadata.orthophoto.presets),
	}));
	selectedPreset.value = currentPreset;
	orthophotoControlVisible.value = true;
}

function updateStats(
	metadata: TerrainMetadata,
	currentPreset: OrthophotoPresetId,
) {
	const demSource =
		metadata.sourceFiles.length === 1
			? metadata.sourceFiles[0]
			: `${metadata.sourceFiles.length} DEM tiles`;
	statsData.value = {
		source: `${demSource} + ${formatOrthophotoSourceLabel(metadata, currentPreset)} (${formatPresetLabel(currentPreset)})`,
		footprint: `${formatDistance(metadata.sizeMeters.width)} x ${formatDistance(metadata.sizeMeters.height)}`,
		elevationRange: `${metadata.elevationRange.min.toFixed(0)} m to ${metadata.elevationRange.max.toFixed(0)} m`,
		bounds: formatBounds(metadata),
	};
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
	if (!width || !height) return;
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
			buildLinePositions(overlay.segments[index]!, exaggeration),
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
	if (bounds.isEmpty()) return;
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

function renderNamedPlaceLegend(metadata: TerrainMetadata) {
	if (!metadata.namedPlaces) {
		namedPlaceLegendVisible.value = false;
		namedPlaceLegend.value = [];
		namedPlaceLegendCount.value = 0;
		return;
	}

	const categories = Object.entries(metadata.namedPlaces.categories).filter(
		([, info]) => info.count > 0,
	);
	namedPlaceLegendCount.value = metadata.namedPlaces.featureCount;
	namedPlaceLegend.value = categories.map(([category, info]) => ({
		category,
		color: info.color,
		label: info.label,
		count: info.count,
	}));
}

function hideNamedPlaceLabels() {
	if (!terrainRuntime?.namedPlaceOverlay) return;
	for (const label of terrainRuntime.namedPlaceOverlay.labelElements) {
		label.hidden = true;
	}
}

function setNamedPlacesVisible(visible: boolean, persist = true) {
	if (!terrainRuntime?.namedPlaceOverlay) {
		namedPlacesChecked.value = visible;
		namedPlaceToggleVisible.value = false;
		namedPlaceLegendVisible.value = false;
		return;
	}

	terrainRuntime.namedPlacesVisible = visible;
	terrainRuntime.namedPlaceOverlay.group.visible = visible;
	namedPlacesChecked.value = visible;
	namedPlaceToggleVisible.value = true;
	namedPlaceLegendVisible.value = visible;
	if (!visible) {
		hideNamedPlaceLabels();
	} else {
		updateNamedPlaceOverlay(
			terrainRuntime.namedPlaceOverlay,
			terrainRuntime.currentExaggeration,
			camera,
			canvas,
		);
	}
	if (persist) {
		persistNamedPlacesVisible(visible);
	}
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
	if (!terrainRuntime || pressedKeys.size === 0) return;

	keyboardForward.subVectors(controls.target, camera.position);
	keyboardForward.y = 0;
	if (keyboardForward.lengthSq() < 1e-6) {
		camera.getWorldDirection(keyboardForward);
		keyboardForward.y = 0;
	}
	if (keyboardForward.lengthSq() < 1e-6) return;

	keyboardForward.normalize();
	keyboardRight.crossVectors(keyboardForward, camera.up).normalize();
	keyboardOffset.set(0, 0, 0);

	if (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp"))
		keyboardOffset.add(keyboardForward);
	if (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown"))
		keyboardOffset.sub(keyboardForward);
	if (pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight"))
		keyboardOffset.add(keyboardRight);
	if (pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft"))
		keyboardOffset.sub(keyboardRight);
	if (pressedKeys.has("KeyE") || pressedKeys.has("PageUp"))
		keyboardOffset.y += 1;
	if (pressedKeys.has("KeyQ") || pressedKeys.has("PageDown"))
		keyboardOffset.y -= 1;

	if (keyboardOffset.lengthSq() === 0) return;

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
	if (!clientWidth || !clientHeight) return;
	renderer.setSize(clientWidth, clientHeight, false);
	camera.aspect = clientWidth / clientHeight;
	camera.updateProjectionMatrix();
	updateTrackMaterialsResolution();
}

async function applyOrthophotoPreset(
	presetId: OrthophotoPresetId,
	persistSelection = true,
) {
	if (!terrainRuntime || orthophotoSwitchInFlight) return;

	if (terrainRuntime.currentOrthophotoPreset === presetId) {
		if (persistSelection) persistPresetSelection(presetId);
		return;
	}

	orthophotoSwitchInFlight = true;
	presetSelectDisabled.value = true;

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
		selectedPreset.value = presetId;
		updateStats(terrainRuntime.metadata, presetId);
		if (persistSelection) persistPresetSelection(presetId);
		setStatus(
			`Terrain ready. ${formatPresetLabel(presetId)} orthophoto loaded; upload a GPX file to overlay a track.`,
		);
	} catch (error) {
		selectedPreset.value = terrainRuntime.currentOrthophotoPreset;
		setStatus(
			error instanceof Error
				? error.message
				: "Orthophoto resolution switch failed.",
			true,
		);
	} finally {
		presetSelectDisabled.value = false;
		orthophotoSwitchInFlight = false;
	}
}

function createTrackOverlay(name: string, segments: TrackSegment[]) {
	if (!terrainRuntime) throw new Error("Terrain is not ready yet.");

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
	if (!terrainRuntime || !files || files.length === 0) return;

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

	trackItems.value = [...trackOverlays];

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
	const currentPreset = getStoredPreset(metadata);
	populateOrthophotoPresetControl(metadata, currentPreset);
	presetSelectDisabled.value = true;

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
		currentPreset,
		metadataResponse.url,
	);
	const namedPlaceFeatures = metadata.namedPlaces
		? await loadNamedPlaceFeatures(metadata, metadataResponse.url)
		: [];

	setStatus("Preparing 3D terrain...");
	const heightCodes = new Uint16Array(rawHeightBuffer);
	const heights = buildHeightArray(heightCodes, metadata);
	const surfaceTexture = await buildSurfaceTexture(
		metadata,
		heights,
		orthophotoPixels,
		metadata.orthophoto.presets[currentPreset],
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

	const namedPlaceOverlay =
		namedPlaceFeatures.length > 0
			? createNamedPlaceOverlay(namedPlaceFeatures, metadata, viewerOverlay)
			: null;
	if (namedPlaceOverlay) {
		scene.add(namedPlaceOverlay.group);
	}

	terrainRuntime = {
		mesh,
		geometry,
		heights,
		heightCodes,
		metadata,
		assetsBaseUrl: metadataResponse.url,
		currentExaggeration: metadata.defaultVerticalExaggeration,
		currentOrthophotoPreset: currentPreset,
		namedPlaceOverlay,
		namedPlacesVisible: namedPlaceOverlay
			? getStoredNamedPlacesVisible()
			: false,
	};

	exaggerationRange.value = metadata.defaultVerticalExaggeration.toFixed(1);
	exaggerationDisplay.value = `${metadata.defaultVerticalExaggeration.toFixed(1)}x`;

	updateStats(metadata, currentPreset);
	renderNamedPlaceLegend(metadata);
	persistPresetSelection(currentPreset);
	resetCamera(metadata, metadata.defaultVerticalExaggeration);
	resizeRenderer();
	setNamedPlacesVisible(terrainRuntime.namedPlacesVisible, false);

	controlsVisible.value = true;
	presetSelectDisabled.value = false;
	trackItems.value = [...trackOverlays];
	setStatus(
		`Terrain ready. ${formatPresetLabel(currentPreset)} orthophoto and natural-feature overlay loaded; upload a GPX file to overlay a track.`,
	);
}

function animate() {
	const deltaSeconds = Math.min(clock.getDelta(), 0.1);
	animationHandle = window.requestAnimationFrame(animate);
	updateKeyboardNavigation(deltaSeconds);
	controls.update();
	if (terrainRuntime?.namedPlaceOverlay && terrainRuntime.namedPlacesVisible) {
		updateNamedPlaceOverlay(
			terrainRuntime.namedPlaceOverlay,
			terrainRuntime.currentExaggeration,
			camera,
			canvas,
		);
	}
	renderer.render(scene, camera);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
	throw new Error("Application root was not found.");
}

render(<App />, app);

canvas = app.querySelector<HTMLCanvasElement>("canvas.viewer")!;
viewerOverlay = app.querySelector<HTMLElement>(".viewer-overlay")!;

renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xd8e2da, 12000, 40000);

camera = new THREE.PerspectiveCamera(45, 1, 10, 100000);
controls = new OrbitControls(camera, renderer.domElement);
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

const resizeObserver = new ResizeObserver(() => resizeRenderer());
resizeObserver.observe(canvas);
window.addEventListener("resize", resizeRenderer);
window.addEventListener("keydown", (event) => {
	if (!KEYBOARD_MOVE_CODES.has(event.code) || event.repeat) return;
	if (isEditableTarget(event.target)) return;
	pressedKeys.add(event.code);
	event.preventDefault();
});
window.addEventListener("keyup", (event) => {
	if (!KEYBOARD_MOVE_CODES.has(event.code)) return;
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
	if (terrainRuntime?.namedPlaceOverlay) {
		disposeNamedPlaceOverlay(terrainRuntime.namedPlaceOverlay);
	}
	const mat = terrainRuntime?.mesh.material;
	mat?.map?.dispose();
});
