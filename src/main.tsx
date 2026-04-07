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
import {
	applyHeights,
	buildHeightArray,
	sampleTerrainHeightAt,
} from "./terrain/heights";
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
const trackFeedback = signal<TrackFeedback>(null);
const trackItems = signal<TrackOverlay[]>([]);
const namedPlaceToggleVisible = signal(false);
const namedPlacesChecked = signal(true);
const namedPlaceLegendVisible = signal(false);
const namedPlaceLegend = signal<NamedPlaceLegendEntry[]>([]);
const namedPlaceLegendCount = signal(0);
const fullscreenActive = signal(false);
const walkModeOn = signal(false);
const trackFollowOn = signal(false);
const trackFollowActiveId = signal<string | null>(null);

// ─── Preact components ────────────────────────────────────────────────────────

function TrackListItem({ overlay }: { overlay: TrackOverlay }) {
	const isFollowing =
		trackFollowActiveId.value === overlay.id && trackFollowOn.value;
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
						class={
							isFollowing ? "track-button track-button-active" : "track-button"
						}
						onClick={() => handleTrackFollow(overlay)}
					>
						{isFollowing ? "Stop follow" : "Follow"}
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
				<button
					class="viewer-action-button"
					type="button"
					onClick={handleFullscreenToggle}
				>
					{fullscreenActive.value ? "Exit fullscreen" : "Enter fullscreen"}
				</button>
				{controlsVisible.value && (
					<button
						class="viewer-action-button viewer-action-button--walk"
						type="button"
						onClick={handleWalkModeToggle}
					>
						{walkModeOn.value ? "Exit surface view" : "Surface view"}
					</button>
				)}
				<canvas class="viewer" aria-label="3D terrain viewer" />
				<div class="viewer-overlay" />
				{trackFollowOn.value ? (
					<div class="viewer-hint">
						<strong>Track follow</strong>
						<span>
							W/S or arrows to move along track · Mouse to look · Shift to
							accelerate · Escape to exit.
						</span>
					</div>
				) : walkModeOn.value ? (
					<div class="viewer-hint">
						<strong>Surface view</strong>
						<span>
							WASD or arrows to move · Mouse to look · Shift to accelerate · V
							or button to exit.
						</span>
					</div>
				) : (
					<div class="viewer-hint">
						<strong>Keyboard</strong>
						<span>
							WASD or arrows to move, Q/E or PgUp/PgDn for altitude, Shift to
							accelerate, F for fullscreen.
						</span>
					</div>
				)}
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
let viewerShell!: HTMLElement;
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

// ─── Track follow mode state ──────────────────────────────────────────────────

type TrackFollowPoint = { x: number; y: number; z: number; dist: number };

const FOLLOW_HEIGHT_OFFSET = 5;
const FOLLOW_SPEED = 40; // m/s base
const FOLLOW_NEAR_PLANE = 1;

let followPath: TrackFollowPoint[] = [];
let followDist = 0; // current arc-length position along path
let followModeActive = false;

function buildFollowPath(overlay: TrackOverlay): TrackFollowPoint[] {
	const points: TrackFollowPoint[] = [];
	let dist = 0;
	for (const segment of overlay.segments) {
		for (let i = 0; i < segment.points.length; i++) {
			const p = segment.points[i]!;
			const y = p.terrainHeight + FOLLOW_HEIGHT_OFFSET;
			if (points.length > 0) {
				const prev = points[points.length - 1]!;
				const dx = p.x - prev.x;
				const dz = p.z - prev.z;
				dist += Math.sqrt(dx * dx + dz * dz);
			}
			points.push({ x: p.x, y, z: p.z, dist });
		}
	}
	return points;
}

function sampleFollowPath(path: TrackFollowPoint[], d: number) {
	if (path.length === 0) return null;
	const last = path[path.length - 1]!;
	const clamped = THREE.MathUtils.clamp(d, 0, last.dist);
	let lo = 0;
	let hi = path.length - 1;
	while (lo + 1 < hi) {
		const mid = (lo + hi) >> 1;
		if (path[mid]!.dist <= clamped) lo = mid;
		else hi = mid;
	}
	const a = path[lo]!;
	const b = path[hi]!;
	const span = b.dist - a.dist;
	const t = span > 0 ? (clamped - a.dist) / span : 0;
	return {
		x: THREE.MathUtils.lerp(a.x, b.x, t),
		y: THREE.MathUtils.lerp(a.y, b.y, t),
		z: THREE.MathUtils.lerp(a.z, b.z, t),
	};
}

function closestDistOnPath(
	path: TrackFollowPoint[],
	cx: number,
	cz: number,
): number {
	let bestDist = 0;
	let bestSq = Infinity;
	for (let i = 0; i + 1 < path.length; i++) {
		const a = path[i]!;
		const b = path[i + 1]!;
		const abx = b.x - a.x;
		const abz = b.z - a.z;
		const abLen2 = abx * abx + abz * abz;
		let t = 0;
		if (abLen2 > 0) {
			t = THREE.MathUtils.clamp(
				((cx - a.x) * abx + (cz - a.z) * abz) / abLen2,
				0,
				1,
			);
		}
		const px = a.x + t * abx;
		const pz = a.z + t * abz;
		const dx = cx - px;
		const dz = cz - pz;
		const sq = dx * dx + dz * dz;
		if (sq < bestSq) {
			bestSq = sq;
			bestDist = a.dist + t * (b.dist - a.dist);
		}
	}
	return bestDist;
}

function enterFollowMode(overlay: TrackOverlay) {
	if (walkModeActive) exitWalkMode();
	followPath = buildFollowPath(overlay);
	if (followPath.length < 2) return;

	// Snap to the closest point on the path to the current camera position
	followDist = closestDistOnPath(
		followPath,
		camera.position.x,
		camera.position.z,
	);

	followModeActive = true;
	trackFollowOn.value = true;
	trackFollowActiveId.value = overlay.id;

	// Inherit current camera look direction
	const dir = new THREE.Vector3();
	camera.getWorldDirection(dir);
	walkEuler.x = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
	const cosPitch = Math.cos(walkEuler.x);
	walkEuler.y =
		cosPitch > 0.01 ? Math.atan2(-dir.x / cosPitch, -dir.z / cosPitch) : 0;
	walkEuler.z = 0;
	camera.rotation.order = "YXZ";
	camera.rotation.set(walkEuler.x, walkEuler.y, 0);

	// Snap camera to the closest path position immediately
	const startPos = sampleFollowPath(followPath, followDist);
	if (startPos) camera.position.set(startPos.x, startPos.y, startPos.z);

	camera.near = FOLLOW_NEAR_PLANE;
	camera.updateProjectionMatrix();
	controls.enabled = false;

	// Blur any focused UI element so keyboard events aren't swallowed
	(document.activeElement as HTMLElement)?.blur();

	void canvas.requestPointerLock();
	requestRender();
}

function exitFollowMode() {
	if (!followModeActive) return;
	followModeActive = false;
	followPath = [];
	trackFollowOn.value = false;
	trackFollowActiveId.value = null;

	camera.near = 10;
	camera.updateProjectionMatrix();

	const dir = new THREE.Vector3();
	camera.getWorldDirection(dir);
	controls.target.copy(camera.position).addScaledVector(dir, 500);
	controls.enabled = true;
	controls.update();
	document.exitPointerLock();
	requestRender();
}

function updateFollowMode(deltaSeconds: number): boolean {
	if (!followModeActive || followPath.length < 2 || pressedKeys.size === 0)
		return false;

	const totalDist = followPath[followPath.length - 1]!.dist;
	const speedMult =
		pressedKeys.has("ShiftLeft") || pressedKeys.has("ShiftRight") ? 2.5 : 1;
	const step = FOLLOW_SPEED * speedMult * deltaSeconds;

	let moved = false;
	if (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) {
		followDist = THREE.MathUtils.clamp(followDist + step, 0, totalDist);
		moved = true;
	}
	if (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown")) {
		followDist = THREE.MathUtils.clamp(followDist - step, 0, totalDist);
		moved = true;
	}

	if (!moved) return false;

	const pos = sampleFollowPath(followPath, followDist);
	if (!pos) return false;
	camera.position.set(pos.x, pos.y, pos.z);

	return true;
}

// ─── Walk mode state ──────────────────────────────────────────────────────────

const WALK_HEIGHT_OFFSET = 5; // real meters above terrain surface
const WALK_PITCH_LIMIT = Math.PI * 0.42; // ~75° max vertical look
const WALK_MOUSE_SENSITIVITY = 0.0018;
const WALK_SPEED = 80; // meters per second (base)
const WALK_NEAR_PLANE = 1; // tighter near clip to avoid terrain clipping

const walkEuler = new THREE.Euler(0, 0, 0, "YXZ");
let walkModeActive = false;

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

async function handleGpxChange(event: Event) {
	await handleTrackUpload((event.target as HTMLInputElement).files);
	(event.target as HTMLInputElement).value = "";
}

function handleNamedPlaceToggle(event: Event) {
	setNamedPlacesVisible((event.target as HTMLInputElement).checked);
}

function handleResetCamera() {
	if (!terrainRuntime) return;
	resetCamera(terrainRuntime.metadata);
}

function handleTrackToggle(overlay: TrackOverlay) {
	overlay.visible = !overlay.visible;
	overlay.object.visible = overlay.visible;
	trackItems.value = [...trackOverlays];
	requestRender();
}

function handleTrackZoom(overlay: TrackOverlay) {
	focusTrackOverlay(overlay);
}

function handleTrackFollow(overlay: TrackOverlay) {
	if (followModeActive && trackFollowActiveId.value === overlay.id) {
		exitFollowMode();
	} else {
		enterFollowMode(overlay);
	}
}

function handleTrackRemove(overlay: TrackOverlay) {
	const index = trackOverlays.findIndex((entry) => entry.id === overlay.id);
	if (index >= 0) {
		if (followModeActive && trackFollowActiveId.value === overlay.id) {
			exitFollowMode();
		}
		disposeTrackOverlay(overlay);
		trackOverlays.splice(index, 1);
		trackItems.value = [...trackOverlays];
		setTrackFeedback(`Removed ${overlay.name}.`, "info");
		requestRender();
	}
}

async function handleFullscreenToggle() {
	if (!viewerShell) return;

	try {
		if (document.fullscreenElement === viewerShell) {
			await document.exitFullscreen();
		} else {
			await viewerShell.requestFullscreen();
		}
	} catch (error) {
		setStatus(
			error instanceof Error
				? error.message
				: "Fullscreen mode could not be changed.",
			true,
		);
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

function syncFullscreenState() {
	fullscreenActive.value = document.fullscreenElement === viewerShell;
	resizeRenderer();
	requestRender();
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

function updateTrackOverlayGeometry(overlay: TrackOverlay) {
	overlay.lines.forEach((line, index) => {
		line.geometry.setPositions(buildLinePositions(overlay.segments[index]!));
		line.computeLineDistances();
	});
	overlay.bounds = computeTrackBounds(overlay);
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
		updateNamedPlaceOverlay(terrainRuntime.namedPlaceOverlay, camera, canvas);
	}
	if (persist) {
		persistNamedPlacesVisible(visible);
	}
	requestRender();
}

function resetCamera(metadata: TerrainMetadata) {
	const maxSpan = Math.max(
		metadata.sizeMeters.width,
		metadata.sizeMeters.height,
	);
	const verticalRange =
		metadata.elevationRange.max - metadata.elevationRange.min;
	camera.position.set(0, maxSpan * 0.42 + verticalRange * 0.8, maxSpan * 0.82);
	controls.target.set(0, verticalRange * 0.18, 0);
	controls.maxDistance = maxSpan * 3.2;
	camera.near = 10;
	camera.far = maxSpan * 8;
	camera.updateProjectionMatrix();
	controls.update();
}

function sampleWorldTerrainRawHeight(worldX: number, worldZ: number): number {
	if (!terrainRuntime) return 0;
	const { metadata } = terrainRuntime;
	const normalizedX =
		(worldX + metadata.sizeMeters.width / 2) / metadata.sizeMeters.width;
	const normalizedZ =
		(worldZ + metadata.sizeMeters.height / 2) / metadata.sizeMeters.height;
	const rasterX = normalizedX * (metadata.width - 1);
	const rasterY = normalizedZ * (metadata.height - 1);
	return sampleTerrainHeightAt(terrainRuntime, rasterX, rasterY) ?? 0;
}

function enterWalkMode() {
	if (!terrainRuntime || walkModeActive) return;
	walkModeActive = true;
	walkModeOn.value = true;

	// Extract yaw/pitch from current camera direction.
	// With YXZ euler: world dir = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))
	const dir = new THREE.Vector3();
	camera.getWorldDirection(dir);
	walkEuler.x = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
	const cosPitch = Math.cos(walkEuler.x);
	walkEuler.y =
		cosPitch > 0.01 ? Math.atan2(-dir.x / cosPitch, -dir.z / cosPitch) : 0;
	walkEuler.z = 0;

	// Snap camera to terrain surface + offset
	const rawHeight = sampleWorldTerrainRawHeight(
		camera.position.x,
		camera.position.z,
	);
	camera.position.y = rawHeight + WALK_HEIGHT_OFFSET;

	camera.rotation.order = "YXZ";
	camera.rotation.set(walkEuler.x, walkEuler.y, 0);

	// Tighter near plane so the terrain isn't clipped when looking down
	camera.near = WALK_NEAR_PLANE;
	camera.updateProjectionMatrix();

	controls.enabled = false;
	(document.activeElement as HTMLElement)?.blur();
	void canvas.requestPointerLock();
	requestRender();
}

function exitWalkMode() {
	if (!walkModeActive) return;
	walkModeActive = false;
	walkModeOn.value = false;

	camera.near = 10;
	camera.updateProjectionMatrix();

	// Place the orbit target in front of the camera so controls feel natural
	const dir = new THREE.Vector3();
	camera.getWorldDirection(dir);
	controls.target.copy(camera.position).addScaledVector(dir, 500);
	controls.enabled = true;
	controls.update();

	document.exitPointerLock();
	requestRender();
}

function handleWalkModeToggle() {
	if (walkModeActive) {
		exitWalkMode();
	} else {
		enterWalkMode();
	}
}

function handleWalkMouseMove(event: MouseEvent) {
	if (
		(!walkModeActive && !followModeActive) ||
		document.pointerLockElement !== canvas
	)
		return;

	walkEuler.y -= event.movementX * WALK_MOUSE_SENSITIVITY;
	walkEuler.x -= event.movementY * WALK_MOUSE_SENSITIVITY;
	walkEuler.x = THREE.MathUtils.clamp(
		walkEuler.x,
		-WALK_PITCH_LIMIT,
		WALK_PITCH_LIMIT,
	);

	camera.rotation.set(walkEuler.x, walkEuler.y, 0);
	requestRender();
}

function updateWalkMode(deltaSeconds: number): boolean {
	if (!terrainRuntime || !walkModeActive) return false;

	let moved = false;

	if (pressedKeys.size > 0) {
		// Camera forward projected onto the XZ plane (no vertical movement)
		const forwardX = -Math.sin(walkEuler.y);
		const forwardZ = -Math.cos(walkEuler.y);
		const rightX = Math.cos(walkEuler.y);
		const rightZ = -Math.sin(walkEuler.y);

		let dx = 0;
		let dz = 0;
		if (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) {
			dx += forwardX;
			dz += forwardZ;
		}
		if (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown")) {
			dx -= forwardX;
			dz -= forwardZ;
		}
		if (pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight")) {
			dx += rightX;
			dz += rightZ;
		}
		if (pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft")) {
			dx -= rightX;
			dz -= rightZ;
		}

		if (dx !== 0 || dz !== 0) {
			const len = Math.sqrt(dx * dx + dz * dz);
			const speedMult =
				pressedKeys.has("ShiftLeft") || pressedKeys.has("ShiftRight") ? 2.5 : 1;
			const step = (WALK_SPEED * speedMult * deltaSeconds) / len;

			camera.position.x += dx * step;
			camera.position.z += dz * step;

			// Keep camera within terrain bounds
			const halfW = terrainRuntime.metadata.sizeMeters.width / 2;
			const halfH = terrainRuntime.metadata.sizeMeters.height / 2;
			camera.position.x = THREE.MathUtils.clamp(
				camera.position.x,
				-halfW * 0.99,
				halfW * 0.99,
			);
			camera.position.z = THREE.MathUtils.clamp(
				camera.position.z,
				-halfH * 0.99,
				halfH * 0.99,
			);

			moved = true;
		}
	}

	// Always track terrain height so the camera stays on the surface
	const rawHeight = sampleWorldTerrainRawHeight(
		camera.position.x,
		camera.position.z,
	);
	const targetY = rawHeight + WALK_HEIGHT_OFFSET;
	if (Math.abs(camera.position.y - targetY) > 0.01) {
		camera.position.y = targetY;
		moved = true;
	}

	return moved;
}

function updateKeyboardNavigation(deltaSeconds: number) {
	if (!terrainRuntime || pressedKeys.size === 0) return false;

	keyboardForward.subVectors(controls.target, camera.position);
	keyboardForward.y = 0;
	if (keyboardForward.lengthSq() < 1e-6) {
		camera.getWorldDirection(keyboardForward);
		keyboardForward.y = 0;
	}
	if (keyboardForward.lengthSq() < 1e-6) return false;

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

	if (keyboardOffset.lengthSq() === 0) return false;

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
	return true;
}

function resizeRenderer() {
	const { clientWidth, clientHeight } = canvas;
	if (!clientWidth || !clientHeight) return;
	renderer.setSize(clientWidth, clientHeight, false);
	camera.aspect = clientWidth / clientHeight;
	camera.updateProjectionMatrix();
	updateTrackMaterialsResolution();
}

function requestRender() {
	if (animationHandle !== 0) return;
	animationHandle = window.requestAnimationFrame(animate);
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
		requestRender();
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
		geometry.setPositions(buildLinePositions(segment));

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

	updateTrackOverlayGeometry(overlay);
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

	applyHeights(geometry, heights);

	const material = new THREE.MeshStandardMaterial({
		map: surfaceTexture,
		roughness: 0.96,
		metalness: 0.02,
		polygonOffset: true,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1,
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
		currentOrthophotoPreset: currentPreset,
		namedPlaceOverlay,
		namedPlacesVisible: namedPlaceOverlay
			? getStoredNamedPlacesVisible()
			: false,
	};

	updateStats(metadata, currentPreset);
	renderNamedPlaceLegend(metadata);
	persistPresetSelection(currentPreset);
	resetCamera(metadata);
	resizeRenderer();
	setNamedPlacesVisible(terrainRuntime.namedPlacesVisible, false);

	controlsVisible.value = true;
	presetSelectDisabled.value = false;
	trackItems.value = [...trackOverlays];
	setStatus(
		`Terrain ready. ${formatPresetLabel(currentPreset)} orthophoto and natural-feature overlay loaded; upload a GPX file to overlay a track.`,
	);
	requestRender();
}

function animate() {
	animationHandle = 0;
	const deltaSeconds = Math.min(clock.getDelta(), 0.1);
	let movedByKeyboard: boolean;
	let controlsChanged: boolean;
	if (followModeActive) {
		movedByKeyboard = updateFollowMode(deltaSeconds);
		controlsChanged = false;
		// mouse look still uses walkEuler — camera.rotation is already set by handleWalkMouseMove
	} else if (walkModeActive) {
		movedByKeyboard = updateWalkMode(deltaSeconds);
		controlsChanged = false;
	} else {
		movedByKeyboard = updateKeyboardNavigation(deltaSeconds);
		controlsChanged = controls.update();
	}
	if (terrainRuntime?.namedPlaceOverlay && terrainRuntime.namedPlacesVisible) {
		updateNamedPlaceOverlay(terrainRuntime.namedPlaceOverlay, camera, canvas);
	}
	renderer.render(scene, camera);
	if (movedByKeyboard || controlsChanged) {
		requestRender();
	}
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
	throw new Error("Application root was not found.");
}

render(<App />, app);

viewerShell = app.querySelector<HTMLElement>(".viewer-shell")!;
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

function handleControlsChange() {
	requestRender();
}

controls.addEventListener("change", handleControlsChange);

const resizeObserver = new ResizeObserver(() => {
	resizeRenderer();
	requestRender();
});
resizeObserver.observe(canvas);
window.addEventListener("resize", () => {
	resizeRenderer();
	requestRender();
});
window.addEventListener("keydown", (event) => {
	if (event.code === "KeyF" && !event.repeat) {
		if (isEditableTarget(event.target)) return;
		event.preventDefault();
		void handleFullscreenToggle();
		return;
	}
	if (event.code === "KeyV" && !event.repeat) {
		if (isEditableTarget(event.target)) return;
		event.preventDefault();
		handleWalkModeToggle();
		return;
	}
	if (event.code === "Escape" && !event.repeat) {
		if (followModeActive) {
			event.preventDefault();
			exitFollowMode();
			return;
		}
		if (walkModeActive) {
			event.preventDefault();
			exitWalkMode();
			return;
		}
	}
	if (!KEYBOARD_MOVE_CODES.has(event.code) || event.repeat) return;
	if (isEditableTarget(event.target)) return;
	const startingMovement = pressedKeys.size === 0;
	pressedKeys.add(event.code);
	if (startingMovement) {
		clock.getDelta();
		requestRender();
	}
	event.preventDefault();
});
window.addEventListener("keyup", (event) => {
	if (!KEYBOARD_MOVE_CODES.has(event.code)) return;
	pressedKeys.delete(event.code);
	requestRender();
});
window.addEventListener("blur", () => {
	pressedKeys.clear();
	requestRender();
});
document.addEventListener("fullscreenchange", syncFullscreenState);
document.addEventListener("pointerlockchange", () => {
	if (document.pointerLockElement === canvas) return;
	if (followModeActive) exitFollowMode();
	else if (walkModeActive) exitWalkMode();
});
canvas.addEventListener("click", () => {
	if (
		(followModeActive || walkModeActive) &&
		document.pointerLockElement !== canvas
	) {
		void canvas.requestPointerLock();
	}
});
window.addEventListener("mousemove", handleWalkMouseMove);

loadTerrain().catch((error) => {
	setStatus(
		error instanceof Error ? error.message : "Terrain loading failed.",
		true,
	);
});

resizeRenderer();
requestRender();

window.addEventListener("beforeunload", () => {
	if (animationHandle !== 0) {
		window.cancelAnimationFrame(animationHandle);
		animationHandle = 0;
	}
	controls.removeEventListener("change", handleControlsChange);
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
	document.removeEventListener("fullscreenchange", syncFullscreenState);
});
