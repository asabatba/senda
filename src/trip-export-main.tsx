import "./trip-export.css";

import { signal } from "@preact/signals";
import { render } from "preact";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import { inflateBinaryAsset } from "./terrain/assets";
import {
	KEYBOARD_MOVE_CODES,
	TRACK_COLORS,
	TRACK_SURFACE_OFFSET,
} from "./terrain/constants";
import {
	applyHeights,
	buildHeightArray,
	sampleHeightBilinear,
} from "./terrain/heights";
import { buildSurfaceTexture } from "./terrain/texture";
import type { OrthophotoPresetId, TerrainMetadata } from "./terrain/types";

// ─── Types ────────────────────────────────────────────────────────────────────

type TripTrackPoint = {
	x: number;
	z: number;
	terrainHeight: number;
	distanceKm: number;
	time: number | null;
};

type TripTrackSegment = {
	name: string;
	points: TripTrackPoint[];
};

type TripPhotoAnchor = {
	id: string;
	clusterId: string;
	imageUrl: string;
	sourceLabel: string;
	description: string | null;
	captureTime: string | null;
	placedBy: string;
	x: number;
	z: number;
	terrainHeight: number;
};

type TripClusterTimeLabel =
	| {
			kind: "instant";
			startTime: string;
			endTime: null;
	  }
	| {
			kind: "range";
			startTime: string;
			endTime: string;
	  };

type TripCluster = {
	id: string;
	x: number;
	z: number;
	terrainHeight: number;
	cardHeight: number;
	memberIds: string[];
	timeLabel: TripClusterTimeLabel | null;
};

type TripBundle = {
	version: number;
	title: string;
	terrain: {
		metadataUrl: string;
		defaultOrthophotoPreset: OrthophotoPresetId;
	};
	display: {
		cardHeight: number;
		timezone?: string;
	};
	stats: {
		trackCount: number;
		imageCount: number;
		clusterCount: number;
	};
	trackSegments: TripTrackSegment[];
	photoAnchors: TripPhotoAnchor[];
	clusters: TripCluster[];
};

type TerrainRuntime = {
	metadata: TerrainMetadata;
	geometry: THREE.PlaneGeometry;
	heights: Float32Array;
	heightCodes: Uint16Array;
	mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
};

type TrackTimelineLabel = {
	anchor: THREE.Object3D;
	element: HTMLDivElement;
	text: string;
	timeMs: number | null;
	priority: number;
};

type CameraFlight = {
	startPosition: THREE.Vector3;
	startTarget: THREE.Vector3;
	endPosition: THREE.Vector3;
	endTarget: THREE.Vector3;
	startTime: number;
	durationMs: number;
};

// ─── Signals ──────────────────────────────────────────────────────────────────

const statusMsg = signal("Loading trip bundle...");
const statusError = signal(false);
const tripStats = signal<TripBundle["stats"] | null>(null);
const tripClusters = signal<TripCluster[]>([]);
const tripPhotoAnchors = signal<TripPhotoAnchor[]>([]);
const resetVisible = signal(false);
const fullscreenActive = signal(false);
const tripHintVisible = signal(true);
const galleryPhotos = signal<TripPhotoAnchor[]>([]);
const galleryIndex = signal(-1);

const TRIP_HINT_AUTO_HIDE_MS = 8000;

// ─── Preact components ────────────────────────────────────────────────────────

function ClusterItem({ cluster }: { cluster: TripCluster }) {
	const anchors = tripPhotoAnchors.value;
	const members = anchors.filter((a) => a.clusterId === cluster.id);
	return (
		<li class="trip-cluster-item" onClick={() => zoomToCluster(cluster)}>
			<strong>
				{members.length === 1
					? members[0]?.sourceLabel
					: `${members.length} photos`}
			</strong>
			<p>
				{members
					.slice(0, 3)
					.map((m) => m.description ?? m.sourceLabel)
					.join(" · ")}
			</p>
		</li>
	);
}

function App() {
	const galleryOpen = galleryIndex.value >= 0;
	const photo = galleryOpen
		? (galleryPhotos.value[galleryIndex.value] ?? null)
		: null;
	const photoCount = galleryPhotos.value.length;
	const photoDateLabel = photo
		? formatExactDateTime(photo.captureTime)
		: "Unknown capture time";

	return (
		<>
			<div class="trip-layout">
				<section class="trip-viewer-shell">
					<button
						class="trip-viewer-action-button"
						type="button"
						onClick={handleFullscreenToggle}
					>
						{fullscreenActive.value ? "Exit fullscreen" : "Enter fullscreen"}
					</button>
					<canvas
						class="trip-viewer"
						aria-label="Trip scene export"
						tabIndex={0}
					/>
					<div class="trip-viewer-overlay" />
					<div
						class={
							tripHintVisible.value
								? "trip-viewer-hint"
								: "trip-viewer-hint trip-viewer-hint-hidden"
						}
						aria-hidden={!tripHintVisible.value}
					>
						<strong>Trip Scene</strong>
						<span>
							Mouse or touch to inspect the route. Focus the scene then use
							WASD/arrows to pan, Q/E for altitude, Shift to accelerate, +/- to
							zoom, R to reset, F for fullscreen.
						</span>
					</div>
					{photo && (
						<div
							class="trip-gallery"
							role="dialog"
							aria-modal="true"
							aria-label="Photo gallery"
							onClick={closeGallery}
							onWheel={handleGalleryWheel}
						>
							<div
								class="trip-gallery-shell"
								onClick={(event) => event.stopPropagation()}
							>
								<button
									class="trip-gallery-close"
									type="button"
									onClick={closeGallery}
									aria-label="Close gallery"
								>
									Close
								</button>
								<button
									class="trip-gallery-nav trip-gallery-nav-prev"
									type="button"
									onClick={() => stepGallery(-1)}
									aria-label="Previous image"
								>
									Prev
								</button>
								<button
									class="trip-gallery-nav trip-gallery-nav-next"
									type="button"
									onClick={() => stepGallery(1)}
									aria-label="Next image"
								>
									Next
								</button>
								<div class="trip-gallery-media">
									<img
										class="trip-gallery-image"
										src={photo.imageUrl}
										alt={photo.description ?? photo.sourceLabel}
									/>
								</div>
								<div class="trip-gallery-meta">
									<div class="trip-gallery-count">
										{galleryIndex.value + 1} / {photoCount}
									</div>
									<h2>{photo.description ?? photo.sourceLabel}</h2>
									<p>{photo.sourceLabel}</p>
									<p>{photoDateLabel}</p>
									<button
										class="trip-gallery-action"
										type="button"
										onClick={() => flyToPhotoFromGallery(photo)}
									>
										Go to location
									</button>
								</div>
							</div>
						</div>
					)}
				</section>
				<aside class="trip-panel">
					<p class="trip-eyebrow">Standalone Export</p>
					<h1 class="trip-title">Trip Scene</h1>
					<p class="trip-lede">
						Terrain, orthophoto, route line, and photo clusters are prepacked
						into this self-contained scene.
					</p>
					<p
						class={
							statusError.value
								? "trip-status trip-status-error"
								: "trip-status"
						}
					>
						{statusMsg.value}
					</p>
					{tripStats.value && (
						<dl class="trip-stats">
							<div>
								<dt>Tracks</dt>
								<dd>{tripStats.value.trackCount}</dd>
							</div>
							<div>
								<dt>Photos</dt>
								<dd>{tripStats.value.imageCount}</dd>
							</div>
							<div>
								<dt>Clusters</dt>
								<dd>{tripStats.value.clusterCount}</dd>
							</div>
						</dl>
					)}
					{tripClusters.value.length > 0 && (
						<section class="trip-cluster-section">
							<div class="trip-cluster-header">
								<span>Photo Clusters</span>
								<strong>{tripClusters.value.length}</strong>
							</div>
							<ul class="trip-cluster-list">
								{tripClusters.value.map((cluster) => (
									<ClusterItem key={cluster.id} cluster={cluster} />
								))}
							</ul>
						</section>
					)}
					{resetVisible.value && (
						<button
							class="trip-reset-button"
							type="button"
							onClick={handleResetCamera}
						>
							Reset camera
						</button>
					)}
				</aside>
			</div>
		</>
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

const trackLines: Line2[] = [];
const clusterObjects: THREE.Object3D[] = [];
const photoSprites: THREE.Sprite[] = [];
const trackTimelineLabels: TrackTimelineLabel[] = [];

let terrainRuntime: TerrainRuntime | null = null;
let tripBundle: TripBundle | null = null;
let animationHandle = 0;
let tripHintHideHandle = 0;
let pointerDownClientX = 0;
let pointerDownClientY = 0;
let pointerDownActive = false;
let lastGalleryWheelAt = 0;
let cameraFlight: CameraFlight | null = null;

const KEYBOARD_ZOOM_FACTOR = 1.16;
const GALLERY_WHEEL_COOLDOWN_MS = 180;
const CLICK_DRAG_THRESHOLD_PX = 8;
const PHOTO_FLIGHT_MIN_DURATION_MS = 650;
const PHOTO_FLIGHT_MAX_DURATION_MS = 1400;

const clock = new THREE.Clock();
const pressedKeys = new Set<string>();
const keyboardForward = new THREE.Vector3();
const keyboardRight = new THREE.Vector3();
const keyboardOffset = new THREE.Vector3();
const labelWorldPos = new THREE.Vector3();
const labelProjectedPos = new THREE.Vector3();
const pointerNdc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const flightTarget = new THREE.Vector3();
const flightPosition = new THREE.Vector3();
const flightOffset = new THREE.Vector3();

// ─── UI callbacks (used in components) ────────────────────────────────────────

function handleResetCamera() {
	if (terrainRuntime) {
		focusScene(terrainRuntime.metadata);
	}
}

function dismissTripHint() {
	if (!tripHintVisible.value) {
		return;
	}
	tripHintVisible.value = false;
	if (tripHintHideHandle) {
		window.clearTimeout(tripHintHideHandle);
		tripHintHideHandle = 0;
	}
}

function scheduleTripHintDismiss() {
	if (tripHintHideHandle) {
		window.clearTimeout(tripHintHideHandle);
	}
	tripHintHideHandle = window.setTimeout(() => {
		tripHintVisible.value = false;
		tripHintHideHandle = 0;
	}, TRIP_HINT_AUTO_HIDE_MS);
}

function openGalleryAt(index: number) {
	const photos = galleryPhotos.value;
	if (photos.length === 0) return;
	const normalizedIndex =
		((index % photos.length) + photos.length) % photos.length;
	galleryIndex.value = normalizedIndex;
	controls.enabled = false;
	dismissTripHint();
	requestRender();
}

function openGalleryForPhoto(photoId: string) {
	const index = galleryPhotos.value.findIndex((photo) => photo.id === photoId);
	if (index >= 0) {
		openGalleryAt(index);
	}
}

function closeGallery() {
	if (galleryIndex.value < 0) return;
	galleryIndex.value = -1;
	controls.enabled = true;
	requestRender();
}

function stepGallery(direction: number) {
	if (galleryIndex.value < 0) return;
	openGalleryAt(galleryIndex.value + direction);
}

function easeInOutCubic(value: number) {
	return value < 0.5
		? 4 * value * value * value
		: 1 - (-2 * value + 2) ** 3 / 2;
}

function beginCameraFlight(
	endTarget: THREE.Vector3,
	endPosition: THREE.Vector3,
) {
	const distance = camera.position.distanceTo(endPosition);
	cameraFlight = {
		startPosition: camera.position.clone(),
		startTarget: controls.target.clone(),
		endPosition: endPosition.clone(),
		endTarget: endTarget.clone(),
		startTime: performance.now(),
		durationMs: THREE.MathUtils.clamp(
			520 + distance * 0.75,
			PHOTO_FLIGHT_MIN_DURATION_MS,
			PHOTO_FLIGHT_MAX_DURATION_MS,
		),
	};
	pressedKeys.clear();
	controls.enabled = false;
	dismissTripHint();
	clock.getDelta();
	requestRender();
}

function updateCameraFlight(now: number) {
	if (!cameraFlight) {
		return false;
	}

	const elapsed = now - cameraFlight.startTime;
	const progress = THREE.MathUtils.clamp(
		elapsed / cameraFlight.durationMs,
		0,
		1,
	);
	const easedProgress = easeInOutCubic(progress);
	camera.position.lerpVectors(
		cameraFlight.startPosition,
		cameraFlight.endPosition,
		easedProgress,
	);
	controls.target.lerpVectors(
		cameraFlight.startTarget,
		cameraFlight.endTarget,
		easedProgress,
	);
	camera.updateProjectionMatrix();
	controls.update();

	if (progress >= 1) {
		controls.enabled = true;
		cameraFlight = null;
		return false;
	}

	return true;
}

function flyToPhotoFromGallery(photo: TripPhotoAnchor) {
	const targetY = photo.terrainHeight + 22;
	flightTarget.set(photo.x, targetY, photo.z);
	flightOffset.set(260, 190, 260);
	const distance = THREE.MathUtils.clamp(
		flightOffset.length(),
		controls.minDistance,
		controls.maxDistance,
	);
	flightOffset.setLength(distance);
	flightPosition.copy(flightTarget).add(flightOffset);
	closeGallery();
	beginCameraFlight(flightTarget, flightPosition);
}

function handleGalleryWheel(event: WheelEvent) {
	if (galleryIndex.value < 0) return;
	event.preventDefault();
	event.stopPropagation();
	const delta =
		Math.abs(event.deltaY) >= Math.abs(event.deltaX)
			? event.deltaY
			: event.deltaX;
	if (Math.abs(delta) < 12) return;
	const now = Date.now();
	if (now - lastGalleryWheelAt < GALLERY_WHEEL_COOLDOWN_MS) return;
	lastGalleryWheelAt = now;
	stepGallery(delta > 0 ? 1 : -1);
}

function zoomToCluster(cluster: TripCluster) {
	cameraFlight = null;
	controls.enabled = true;
	controls.target.set(cluster.x, cluster.terrainHeight, cluster.z);
	camera.position.set(
		cluster.x + 260,
		cluster.terrainHeight + cluster.cardHeight + 180,
		cluster.z + 260,
	);
	controls.update();
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

// ─── Utility functions ────────────────────────────────────────────────────────

function setStatus(message: string, isError = false) {
	statusMsg.value = message;
	statusError.value = isError;
}

function resizeRenderer() {
	const { clientWidth, clientHeight } = canvas;
	if (!clientWidth || !clientHeight) {
		return;
	}
	renderer.setSize(clientWidth, clientHeight, false);
	camera.aspect = clientWidth / clientHeight;
	camera.updateProjectionMatrix();
	for (const line of trackLines) {
		line.material.resolution.set(clientWidth, clientHeight);
	}
}

function syncFullscreenState() {
	fullscreenActive.value = document.fullscreenElement === viewerShell;
	resizeRenderer();
	requestRender();
}

function buildTrackPositions(points: TripTrackPoint[]) {
	const positions: number[] = [];
	for (const point of points) {
		positions.push(
			point.x,
			point.terrainHeight + TRACK_SURFACE_OFFSET,
			point.z,
		);
	}
	return positions;
}

function renderTrackSegments(segments: TripTrackSegment[]) {
	for (const line of trackLines) {
		scene.remove(line);
		line.geometry.dispose();
		line.material.dispose();
	}
	trackLines.length = 0;

	for (const [index, segment] of segments.entries()) {
		const geometry = new LineGeometry();
		geometry.setPositions(buildTrackPositions(segment.points));

		const material = new LineMaterial({
			color: TRACK_COLORS[index % TRACK_COLORS.length],
			linewidth: 4,
			transparent: true,
			opacity: 0.96,
			depthWrite: false,
		});
		material.resolution.set(canvas.clientWidth, canvas.clientHeight);

		const line = new Line2(geometry, material);
		line.computeLineDistances();
		line.frustumCulled = false;
		scene.add(line);
		trackLines.push(line);
	}
}

function formatIsoDateTime(value: string | number | null, timezone?: string) {
	if (value === null) {
		return null;
	}

	const parsed = typeof value === "number" ? value : Date.parse(value);
	if (Number.isNaN(parsed)) {
		return typeof value === "string" ? value : null;
	}

	if (timezone) {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		})
			.format(parsed)
			.replace(", ", " ");
	}

	return new Date(parsed).toISOString().slice(0, 19).replace("T", " ");
}

function clearTrackTimelineLabels() {
	for (const label of trackTimelineLabels) {
		scene.remove(label.anchor);
		label.element.remove();
	}
	trackTimelineLabels.length = 0;
}

function interpolateAtTime(points: TripTrackPoint[], targetMs: number) {
	for (let i = 1; i < points.length; i += 1) {
		const start = points[i - 1]!;
		const end = points[i]!;
		if (start.time === null || end.time === null) continue;
		if (start.time <= targetMs && end.time >= targetMs) {
			const span = end.time - start.time;
			const t = span <= 0 ? 0 : (targetMs - start.time) / span;
			return {
				x: THREE.MathUtils.lerp(start.x, end.x, t),
				y:
					THREE.MathUtils.lerp(start.terrainHeight, end.terrainHeight, t) +
					TRACK_SURFACE_OFFSET +
					28,
				z: THREE.MathUtils.lerp(start.z, end.z, t),
			};
		}
	}
	return null;
}

type TimelineAnchor = {
	x: number;
	y: number;
	z: number;
	time: number | null;
	kind: "start" | "end" | "hour";
};

type TimelineLabelCandidate = {
	x: number;
	y: number;
	z: number;
	timeMs: number | null;
	text: string;
	priority: number;
	alwaysShow?: boolean;
};

function collectTimelineLabelAnchors(
	points: TripTrackPoint[],
): TimelineAnchor[] {
	if (points.length === 0) return [];

	const firstPoint = points[0]!;
	const lastPoint = points.at(-1)!;
	const anchors: TimelineAnchor[] = [];

	anchors.push({
		x: firstPoint.x,
		y: firstPoint.terrainHeight + TRACK_SURFACE_OFFSET + 28,
		z: firstPoint.z,
		time: firstPoint.time,
		kind: "start",
	});

	const startMs = firstPoint.time;
	const endMs = lastPoint.time;
	if (startMs !== null && endMs !== null && endMs > startMs) {
		const MIN_GAP_MS = 10 * 60 * 1000;
		const HOUR_MS = 3_600_000;
		const firstHour = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
		for (let t = firstHour; t < endMs; t += HOUR_MS) {
			if (t - startMs < MIN_GAP_MS) continue;
			if (endMs - t < MIN_GAP_MS) continue;
			const pos = interpolateAtTime(points, t);
			if (pos) anchors.push({ ...pos, time: t, kind: "hour" });
		}
	}

	anchors.push({
		x: lastPoint.x,
		y: lastPoint.terrainHeight + TRACK_SURFACE_OFFSET + 28,
		z: lastPoint.z,
		time: lastPoint.time,
		kind: "end",
	});

	return anchors;
}

function formatTimelineLabel(
	time: number | null,
	kind: TimelineAnchor["kind"],
): string | null {
	if (time === null) return null;
	if (kind === "hour") {
		return formatClockTime(time);
	}
	return formatIsoDateTime(time, tripBundle?.display.timezone);
}

function formatClockTime(value: number | string | null) {
	if (value === null) return null;
	const parsed = typeof value === "number" ? value : Date.parse(value);
	if (Number.isNaN(parsed)) return null;
	const timezone = tripBundle?.display.timezone;
	if (timezone) {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).formatToParts(new Date(parsed));
		const h = parts.find((p) => p.type === "hour")?.value ?? "00";
		const m = parts.find((p) => p.type === "minute")?.value ?? "00";
		return `${h}:${m}`;
	}
	return new Date(parsed).toISOString().slice(11, 16);
}

function formatClusterTimeLabel(label: TripClusterTimeLabel | null) {
	if (!label) return null;
	const startText = formatClockTime(label.startTime);
	if (!startText) return null;
	if (label.kind === "instant" || !label.endTime) {
		return startText;
	}
	const endText = formatClockTime(label.endTime);
	if (!endText || endText === startText) {
		return startText;
	}
	return `${startText}-${endText}`;
}

function formatExactDateTime(value: string | null) {
	if (!value) return "Unknown capture time";
	return formatIsoDateTime(value, tripBundle?.display.timezone);
}

function compareTripPhotos(left: TripPhotoAnchor, right: TripPhotoAnchor) {
	const leftTime = left.captureTime
		? Date.parse(left.captureTime)
		: Number.POSITIVE_INFINITY;
	const rightTime = right.captureTime
		? Date.parse(right.captureTime)
		: Number.POSITIVE_INFINITY;
	if (leftTime !== rightTime) {
		return leftTime - rightTime;
	}
	return left.sourceLabel.localeCompare(right.sourceLabel);
}

function worldToHeightmapSample(
	metadata: TerrainMetadata,
	x: number,
	z: number,
) {
	const normalizedX =
		(x + metadata.sizeMeters.width / 2) / metadata.sizeMeters.width;
	const normalizedY =
		(z + metadata.sizeMeters.height / 2) / metadata.sizeMeters.height;
	return {
		x: normalizedX * (metadata.width - 1),
		y: normalizedY * (metadata.height - 1),
	};
}

function isLabelOccludedByTerrain(worldPos: THREE.Vector3) {
	if (!terrainRuntime) {
		return false;
	}

	const { metadata, heights } = terrainRuntime;
	const cameraPos = camera.position;
	const horizontalDistance = Math.hypot(
		worldPos.x - cameraPos.x,
		worldPos.z - cameraPos.z,
	);
	if (horizontalDistance < 1) {
		return false;
	}

	const sampleCount = THREE.MathUtils.clamp(
		Math.ceil(horizontalDistance / 320),
		6,
		24,
	);

	for (let step = 1; step < sampleCount; step += 1) {
		const t = step / sampleCount;
		const sampleX = THREE.MathUtils.lerp(cameraPos.x, worldPos.x, t);
		const sampleZ = THREE.MathUtils.lerp(cameraPos.z, worldPos.z, t);
		const terrainSample = worldToHeightmapSample(metadata, sampleX, sampleZ);
		const terrainHeight = sampleHeightBilinear(
			heights,
			metadata.width,
			metadata.height,
			terrainSample.x,
			terrainSample.y,
		);
		const sightlineHeight = THREE.MathUtils.lerp(cameraPos.y, worldPos.y, t);
		if (terrainHeight > sightlineHeight - 6) {
			return true;
		}
	}

	return false;
}

function appendTimelineLabel(
	x: number,
	y: number,
	z: number,
	text: string,
	timeMs: number | null,
	priority: number,
) {
	const element = document.createElement("div");
	element.className = "trip-track-label";
	element.textContent = text;
	element.hidden = true;
	viewerOverlay.append(element);

	const anchorObject = new THREE.Object3D();
	anchorObject.position.set(x, y, z);
	scene.add(anchorObject);

	trackTimelineLabels.push({
		anchor: anchorObject,
		element,
		text,
		timeMs,
		priority,
	});
	return true;
}

function buildTrackTimelineLabels(
	segments: TripTrackSegment[],
	clusters: TripCluster[],
) {
	clearTrackTimelineLabels();

	const candidates: TimelineLabelCandidate[] = [];

	for (const segment of segments) {
		for (const anchor of collectTimelineLabelAnchors(segment.points)) {
			const text = formatTimelineLabel(anchor.time, anchor.kind);
			if (!text) continue;
			candidates.push({
				x: anchor.x,
				y: anchor.y,
				z: anchor.z,
				timeMs: anchor.time,
				text,
				priority: anchor.kind === "hour" ? 2 : 0,
				alwaysShow: anchor.kind === "start" || anchor.kind === "end",
			});
		}
	}

	for (const cluster of clusters) {
		const text = formatClusterTimeLabel(cluster.timeLabel);
		if (!text) continue;
		const clusterTimeMs = Date.parse(cluster.timeLabel?.startTime ?? "");
		const sortTimeMs = Number.isNaN(clusterTimeMs) ? null : clusterTimeMs;

		candidates.push({
			x: cluster.x,
			y: cluster.terrainHeight + TRACK_SURFACE_OFFSET + 28,
			z: cluster.z,
			timeMs: sortTimeMs,
			text,
			priority: 1,
			alwaysShow: true,
		});
	}

	candidates.sort((a, b) => {
		if (a.priority !== b.priority) {
			return a.priority - b.priority;
		}
		if (a.timeMs === null && b.timeMs === null) return 0;
		if (a.timeMs === null) return -1;
		if (b.timeMs === null) return 1;
		return a.timeMs - b.timeMs;
	});

	const MIN_TIME_GAP_MS = 20 * 60 * 1000;
	for (const candidate of candidates) {
		const tooCloseInTime =
			!candidate.alwaysShow &&
			candidate.timeMs !== null &&
			trackTimelineLabels.some(
				(label) =>
					label.timeMs !== null &&
					Math.abs(label.timeMs - candidate.timeMs) <= MIN_TIME_GAP_MS,
			);
		if (tooCloseInTime) {
			continue;
		}

		appendTimelineLabel(
			candidate.x,
			candidate.y,
			candidate.z,
			candidate.text,
			candidate.timeMs,
			candidate.priority,
		);
	}
}

function updateTrackTimelineLabels() {
	if (trackTimelineLabels.length === 0) return;

	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	if (!width || !height) return;

	for (const label of trackTimelineLabels) {
		label.anchor.getWorldPosition(labelWorldPos);
		labelProjectedPos.copy(labelWorldPos).project(camera);

		const inFrustum =
			labelProjectedPos.z >= -1 &&
			labelProjectedPos.z <= 1 &&
			labelProjectedPos.x >= -1.08 &&
			labelProjectedPos.x <= 1.08 &&
			labelProjectedPos.y >= -1.08 &&
			labelProjectedPos.y <= 1.08;

		const visible = inFrustum && !isLabelOccludedByTerrain(labelWorldPos);

		label.element.hidden = !visible;
		if (!visible) continue;

		const screenX = ((labelProjectedPos.x + 1) / 2) * width;
		const screenY = ((1 - labelProjectedPos.y) / 2) * height;
		label.element.style.transform = `translate(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px)`;
	}
}

function drawCardTextBlock(
	context: CanvasRenderingContext2D,
	width: number,
	height: number,
	description: string | null,
) {
	const hasDescription = Boolean(description && description.trim().length > 0);
	const lines = [hasDescription ? (description?.trim() ?? null) : null].filter(
		(value): value is string => Boolean(value),
	);

	if (lines.length === 0) {
		return;
	}

	const blockHeight = 74;
	context.fillStyle = "rgba(12, 18, 21, 0.54)";
	context.fillRect(0, height - blockHeight, width, blockHeight);

	if (hasDescription) {
		context.fillStyle = "#fff6dd";
		context.font = "600 28px Georgia";
		context.fillText(lines[0], 28, height - 28, width - 56);
	}
}

async function loadTextureFromImage(
	imageUrl: string,
	description: string | null,
) {
	const image = await new Promise<HTMLImageElement>((resolveImage, reject) => {
		const element = new Image();
		element.decoding = "async";
		element.onload = () => resolveImage(element);
		element.onerror = () => reject(new Error(`Failed to load ${imageUrl}.`));
		element.src = imageUrl;
	});

	const width = 640;
	const height = 420;
	const canvasElement = document.createElement("canvas");
	canvasElement.width = width;
	canvasElement.height = height;
	const context = canvasElement.getContext("2d");
	if (!context) {
		throw new Error("Could not create a 2D context for trip cards.");
	}

	const scale = Math.max(width / image.width, height / image.height);
	const drawWidth = image.width * scale;
	const drawHeight = image.height * scale;
	const offsetX = (width - drawWidth) / 2;
	const offsetY = (height - drawHeight) / 2;

	context.fillStyle = "#102127";
	context.fillRect(0, 0, width, height);
	context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
	drawCardTextBlock(context, width, height, description);
	context.strokeStyle = "rgba(255, 246, 221, 0.34)";
	context.lineWidth = 12;
	context.strokeRect(6, 6, width - 12, height - 12);

	const texture = new THREE.CanvasTexture(canvasElement);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;
}

async function buildClusterObject(
	cluster: TripCluster,
	anchors: TripPhotoAnchor[],
) {
	const group = new THREE.Group();
	group.position.set(cluster.x, 0, cluster.z);
	group.renderOrder = 30;

	const CARD_W = 250;
	const CARD_H = 164;
	const CARD_GAP = 10;
	const anchorY = cluster.terrainHeight + 6;
	const cardY = anchorY + cluster.cardHeight;
	const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
	const members = cluster.memberIds
		.map((id) => anchorById.get(id))
		.filter((anchor): anchor is TripPhotoAnchor => Boolean(anchor));
	const marker = new THREE.Mesh(
		new THREE.SphereGeometry(10, 20, 20),
		new THREE.MeshStandardMaterial({
			color: "#ffd37b",
			emissive: "#865f15",
			roughness: 0.42,
			metalness: 0.04,
		}),
	);
	marker.position.set(0, anchorY, 0);
	group.add(marker);

	const lineGeometry = new THREE.BufferGeometry().setFromPoints([
		new THREE.Vector3(0, anchorY + 10, 0),
		new THREE.Vector3(0, cardY - CARD_H / 2, 0),
	]);
	const line = new THREE.Line(
		lineGeometry,
		new THREE.LineBasicMaterial({
			color: 0xf2d39a,
			transparent: true,
			opacity: 0.9,
			depthWrite: false,
		}),
	);
	group.add(line);

	const previewMembers = members.slice(0, Math.min(members.length, 3));
	for (let index = previewMembers.length - 1; index >= 0; index -= 1) {
		const preview = previewMembers[index];
		const texture = await loadTextureFromImage(
			preview.imageUrl,
			index === 0 ? preview.description : null,
		);
		const sprite = new THREE.Sprite(
			new THREE.SpriteMaterial({
				map: texture,
				transparent: true,
				depthWrite: false,
			}),
		);
		sprite.scale.set(CARD_W, CARD_H, 1);
		sprite.position.set(0, cardY + index * (CARD_H + CARD_GAP), 0);
		sprite.renderOrder = 32 + index;
		sprite.userData.photoId = preview.id;
		group.add(sprite);
		photoSprites.push(sprite);
	}

	return group;
}

function disposeClusterObject(object: THREE.Object3D) {
	object.traverse((node) => {
		if ("geometry" in node && node.geometry) {
			node.geometry.dispose();
		}
		if ("material" in node && node.material) {
			const materials = Array.isArray(node.material)
				? node.material
				: [node.material];
			for (const material of materials) {
				if ("map" in material && material.map) {
					material.map.dispose();
				}
				material.dispose();
			}
		}
	});
	scene.remove(object);
}

async function renderClusters(
	clusters: TripCluster[],
	anchors: TripPhotoAnchor[],
) {
	for (const object of clusterObjects) {
		disposeClusterObject(object);
	}
	clusterObjects.length = 0;
	photoSprites.length = 0;

	for (const cluster of clusters) {
		const clusterObject = await buildClusterObject(cluster, anchors);
		clusterObjects.push(clusterObject);
		scene.add(clusterObject);
	}
}

function focusScene(metadata: TerrainMetadata) {
	cameraFlight = null;
	controls.enabled = true;
	const maxSpan = Math.max(
		metadata.sizeMeters.width,
		metadata.sizeMeters.height,
	);
	const verticalRange =
		metadata.elevationRange.max - metadata.elevationRange.min;

	camera.position.set(0, maxSpan * 0.48 + verticalRange, maxSpan * 0.82);
	controls.target.set(0, verticalRange * 0.15, 0);
	controls.maxDistance = maxSpan * 3.4;
	camera.near = 10;
	camera.far = maxSpan * 8;
	camera.updateProjectionMatrix();
	controls.update();
}

function zoomCamera(scale: number) {
	cameraFlight = null;
	controls.enabled = true;
	const offset = camera.position.clone().sub(controls.target);
	const currentDistance = offset.length();
	const nextDistance = THREE.MathUtils.clamp(
		currentDistance / scale,
		controls.minDistance,
		controls.maxDistance,
	);
	offset.setLength(nextDistance);
	camera.position.copy(controls.target).add(offset);
	controls.update();
}

function updateKeyboardNavigation(deltaSeconds: number) {
	if (!terrainRuntime || pressedKeys.size === 0 || cameraFlight) {
		return false;
	}

	keyboardForward.subVectors(controls.target, camera.position);
	keyboardForward.y = 0;
	if (keyboardForward.lengthSq() < 1e-6) {
		camera.getWorldDirection(keyboardForward);
		keyboardForward.y = 0;
	}
	if (keyboardForward.lengthSq() < 1e-6) {
		return false;
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
		return false;
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
	return true;
}

function openGalleryFromPointerEvent(event: PointerEvent) {
	if (galleryIndex.value >= 0 || photoSprites.length === 0) {
		return;
	}

	const rect = canvas.getBoundingClientRect();
	pointerNdc.set(
		((event.clientX - rect.left) / rect.width) * 2 - 1,
		-(((event.clientY - rect.top) / rect.height) * 2 - 1),
	);
	raycaster.setFromCamera(pointerNdc, camera);
	const hit = raycaster.intersectObjects(photoSprites, false)[0];
	const photoId = hit?.object.userData.photoId;
	if (typeof photoId === "string") {
		openGalleryForPhoto(photoId);
	}
}

function requestRender() {
	if (animationHandle !== 0) {
		return;
	}
	animationHandle = window.requestAnimationFrame(animate);
}

function handleViewerKeyboard(event: KeyboardEvent) {
	if (galleryIndex.value >= 0 || cameraFlight) {
		return;
	}

	if (document.activeElement !== canvas) {
		return;
	}

	if (!terrainRuntime) {
		return;
	}

	dismissTripHint();

	switch (event.key) {
		case "f":
		case "F":
			event.preventDefault();
			void handleFullscreenToggle();
			return;
		case "+":
		case "=":
			event.preventDefault();
			zoomCamera(KEYBOARD_ZOOM_FACTOR);
			return;
		case "-":
		case "_":
			event.preventDefault();
			zoomCamera(1 / KEYBOARD_ZOOM_FACTOR);
			return;
		case "0":
		case "r":
		case "R":
		case "Home":
			event.preventDefault();
			focusScene(terrainRuntime.metadata);
			return;
		default:
			return;
	}
}

async function loadTerrainAndTrip() {
	setStatus("Loading trip bundle...");
	const tripResponse = await fetch(new URL("./trip.json", document.baseURI));
	if (!tripResponse.ok) {
		throw new Error(`Trip bundle request failed with ${tripResponse.status}.`);
	}
	const trip = (await tripResponse.json()) as TripBundle;
	tripBundle = trip;

	setStatus("Loading terrain metadata...");
	const metadataResponse = await fetch(
		new URL(trip.terrain.metadataUrl, document.baseURI),
	);
	if (!metadataResponse.ok) {
		throw new Error(
			`Terrain metadata request failed with ${metadataResponse.status}.`,
		);
	}
	const metadata = (await metadataResponse.json()) as TerrainMetadata;
	const preset = metadata.orthophoto.presets[metadata.orthophoto.defaultPreset];

	setStatus("Loading terrain assets...");
	const heightResponse = await fetch(
		new URL(metadata.heightAsset.url, metadataResponse.url),
	);
	if (!heightResponse.ok) {
		throw new Error(
			`Terrain height request failed with ${heightResponse.status}.`,
		);
	}
	const heightBytes = new Uint8Array(await heightResponse.arrayBuffer());
	const rawHeightBuffer =
		metadata.heightAsset.compression === "gzip"
			? await inflateBinaryAsset(
					heightBytes,
					metadata.width * metadata.height * Uint16Array.BYTES_PER_ELEMENT,
					"Trip terrain height asset",
				)
			: heightBytes.buffer;

	const orthophotoResponse = await fetch(
		new URL(preset.url, metadataResponse.url),
	);
	if (!orthophotoResponse.ok) {
		throw new Error(
			`Terrain orthophoto request failed with ${orthophotoResponse.status}.`,
		);
	}
	const orthophotoBytes = new Uint8Array(
		await orthophotoResponse.arrayBuffer(),
	);
	const rawOrthophotoBuffer =
		preset.compression === "gzip"
			? await inflateBinaryAsset(
					orthophotoBytes,
					preset.width * preset.height * 4,
					"Trip terrain orthophoto asset",
				)
			: orthophotoBytes.buffer;

	setStatus("Preparing scene...");
	const heightCodes = new Uint16Array(rawHeightBuffer);
	const heights = buildHeightArray(heightCodes, metadata);
	const texture = await buildSurfaceTexture(
		metadata,
		heights,
		new Uint8Array(rawOrthophotoBuffer),
		preset,
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
		map: texture,
		roughness: 0.96,
		metalness: 0.03,
		polygonOffset: true,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1,
	});
	const mesh = new THREE.Mesh(geometry, material);
	scene.add(mesh);

	terrainRuntime = {
		metadata,
		geometry,
		heights,
		heightCodes,
		mesh,
	};

	renderTrackSegments(trip.trackSegments);
	await renderClusters(trip.clusters, trip.photoAnchors);
	buildTrackTimelineLabels(trip.trackSegments, trip.clusters);

	tripClusters.value = trip.clusters;
	tripPhotoAnchors.value = trip.photoAnchors;
	galleryPhotos.value = [...trip.photoAnchors].sort(compareTripPhotos);
	galleryIndex.value = -1;
	tripStats.value = trip.stats;
	resetVisible.value = true;

	focusScene(metadata);
	resizeRenderer();
	setStatus("Trip scene ready.");
	scheduleTripHintDismiss();
	requestRender();
}

function animate() {
	animationHandle = 0;
	const deltaSeconds = Math.min(clock.getDelta(), 0.1);
	const movedByKeyboard = updateKeyboardNavigation(deltaSeconds);
	const flightActive = updateCameraFlight(performance.now());
	const controlsChanged =
		!flightActive && controls.enabled ? controls.update() : false;
	updateTrackTimelineLabels();
	renderer.render(scene, camera);
	if (movedByKeyboard || controlsChanged || flightActive) {
		requestRender();
	}
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
	throw new Error("Application root was not found.");
}

render(<App />, app);

viewerShell = app.querySelector<HTMLElement>(".trip-viewer-shell")!;
canvas = app.querySelector<HTMLCanvasElement>(".trip-viewer")!;
viewerOverlay = app.querySelector<HTMLElement>(".trip-viewer-overlay")!;

renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcbd7e2, 7000, 34000);

camera = new THREE.PerspectiveCamera(44, 1, 10, 120000);
controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 220;

scene.add(new THREE.HemisphereLight(0xfbf6e6, 0x33443f, 1.5));

const keyLight = new THREE.DirectionalLight(0xfff0d0, 1.7);
keyLight.position.set(6000, 9000, 5200);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xb9d5ff, 0.45);
fillLight.position.set(-4000, 3600, -4600);
scene.add(fillLight);

function handleControlsChange() {
	requestRender();
}

controls.addEventListener("change", handleControlsChange);

canvas.addEventListener("keydown", handleViewerKeyboard);
canvas.addEventListener("pointerdown", () => {
	canvas.focus({ preventScroll: true });
	dismissTripHint();
});
canvas.addEventListener("pointerdown", (event) => {
	if (event.button !== 0) return;
	pointerDownClientX = event.clientX;
	pointerDownClientY = event.clientY;
	pointerDownActive = true;
});
canvas.addEventListener("pointerup", (event) => {
	if (!pointerDownActive || event.button !== 0) return;
	pointerDownActive = false;
	const movedDistance = Math.hypot(
		event.clientX - pointerDownClientX,
		event.clientY - pointerDownClientY,
	);
	if (movedDistance > CLICK_DRAG_THRESHOLD_PX) {
		return;
	}
	openGalleryFromPointerEvent(event);
});
canvas.addEventListener("pointercancel", () => {
	pointerDownActive = false;
});
window.addEventListener("keydown", (event) => {
	if (galleryIndex.value >= 0) {
		switch (event.code) {
			case "ArrowLeft":
				event.preventDefault();
				stepGallery(-1);
				return;
			case "ArrowRight":
				event.preventDefault();
				stepGallery(1);
				return;
			case "Escape":
				event.preventDefault();
				closeGallery();
				return;
			default:
				return;
		}
	}
	if (cameraFlight) {
		return;
	}
	if (!KEYBOARD_MOVE_CODES.has(event.code) || event.repeat) {
		return;
	}
	if (document.activeElement !== canvas) {
		return;
	}
	const startingMovement = pressedKeys.size === 0;
	dismissTripHint();
	pressedKeys.add(event.code);
	if (startingMovement) {
		clock.getDelta();
		requestRender();
	}
	event.preventDefault();
});
window.addEventListener("keyup", (event) => {
	if (galleryIndex.value >= 0) {
		return;
	}
	if (cameraFlight) {
		pressedKeys.clear();
		return;
	}
	pressedKeys.delete(event.code);
	requestRender();
});
window.addEventListener("blur", () => {
	pressedKeys.clear();
	cameraFlight = null;
	controls.enabled = galleryIndex.value < 0;
	closeGallery();
	requestRender();
});
document.addEventListener("fullscreenchange", syncFullscreenState);

const resizeObserver = new ResizeObserver(() => {
	resizeRenderer();
	requestRender();
});
resizeObserver.observe(canvas);
window.addEventListener("resize", () => {
	resizeRenderer();
	requestRender();
});

loadTerrainAndTrip().catch((error) => {
	setStatus(
		error instanceof Error ? error.message : "Trip scene failed to load.",
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
	if (tripHintHideHandle) {
		window.clearTimeout(tripHintHideHandle);
	}
	controls.removeEventListener("change", handleControlsChange);
	controls.dispose();
	renderer.dispose();
	for (const line of trackLines) {
		line.geometry.dispose();
		line.material.dispose();
	}
	for (const object of clusterObjects) {
		disposeClusterObject(object);
	}
	photoSprites.length = 0;
	clearTrackTimelineLabels();
	terrainRuntime?.mesh.material.map?.dispose();
	terrainRuntime?.mesh.material.dispose();
	terrainRuntime?.geometry.dispose();
	document.removeEventListener("fullscreenchange", syncFullscreenState);
});
