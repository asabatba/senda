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
	applyVerticalExaggeration,
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

type TripCluster = {
	id: string;
	x: number;
	z: number;
	terrainHeight: number;
	cardHeight: number;
	memberIds: string[];
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
	currentExaggeration: number;
};

type TrackTimelineLabel = {
	anchor: THREE.Object3D;
	element: HTMLDivElement;
};

// ─── Signals ──────────────────────────────────────────────────────────────────

const statusMsg = signal("Loading trip bundle...");
const statusError = signal(false);
const tripStats = signal<TripBundle["stats"] | null>(null);
const tripClusters = signal<TripCluster[]>([]);
const tripPhotoAnchors = signal<TripPhotoAnchor[]>([]);
const resetVisible = signal(false);

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
	return (
		<div class="trip-layout">
			<section class="trip-viewer-shell">
				<canvas
					class="trip-viewer"
					aria-label="Trip scene export"
					tabIndex={0}
				/>
				<div class="trip-viewer-overlay" />
				<div class="trip-viewer-hint">
					<strong>Trip Scene</strong>
					<span>
						Mouse or touch to inspect the route. Focus the scene then use
						WASD/arrows to pan, Q/E for altitude, Shift to accelerate, +/- to
						zoom, R to reset.
					</span>
				</div>
			</section>
			<aside class="trip-panel">
				<p class="trip-eyebrow">Standalone Export</p>
				<h1 class="trip-title">Trip Scene</h1>
				<p class="trip-lede">
					Terrain, orthophoto, route line, and photo clusters are prepacked into
					this self-contained scene.
				</p>
				<p
					class={
						statusError.value ? "trip-status trip-status-error" : "trip-status"
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
	);
}

// ─── Three.js module-level state ──────────────────────────────────────────────

let canvas!: HTMLCanvasElement;
let viewerOverlay!: HTMLElement;
let renderer!: THREE.WebGLRenderer;
let scene!: THREE.Scene;
let camera!: THREE.PerspectiveCamera;
let controls!: OrbitControls;

const trackLines: Line2[] = [];
const clusterObjects: THREE.Object3D[] = [];
const trackTimelineLabels: TrackTimelineLabel[] = [];

let terrainRuntime: TerrainRuntime | null = null;
let tripBundle: TripBundle | null = null;
let animationHandle = 0;

const KEYBOARD_ZOOM_FACTOR = 1.16;

const clock = new THREE.Clock();
const pressedKeys = new Set<string>();
const keyboardForward = new THREE.Vector3();
const keyboardRight = new THREE.Vector3();
const keyboardOffset = new THREE.Vector3();
const labelWorldPos = new THREE.Vector3();
const labelProjectedPos = new THREE.Vector3();

// ─── UI callbacks (used in components) ────────────────────────────────────────

function handleResetCamera() {
	if (terrainRuntime) {
		focusScene(terrainRuntime.metadata);
	}
}

function zoomToCluster(cluster: TripCluster) {
	controls.target.set(
		cluster.x,
		cluster.terrainHeight * (terrainRuntime?.currentExaggeration ?? 1),
		cluster.z,
	);
	camera.position.set(
		cluster.x + 260,
		cluster.terrainHeight * (terrainRuntime?.currentExaggeration ?? 1) +
			cluster.cardHeight +
			180,
		cluster.z + 260,
	);
	controls.update();
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

function buildTrackPositions(points: TripTrackPoint[], exaggeration: number) {
	const positions: number[] = [];
	for (const point of points) {
		positions.push(
			point.x,
			point.terrainHeight * exaggeration + TRACK_SURFACE_OFFSET,
			point.z,
		);
	}
	return positions;
}

function renderTrackSegments(
	segments: TripTrackSegment[],
	exaggeration: number,
) {
	for (const line of trackLines) {
		scene.remove(line);
		line.geometry.dispose();
		line.material.dispose();
	}
	trackLines.length = 0;

	for (const [index, segment] of segments.entries()) {
		const geometry = new LineGeometry();
		geometry.setPositions(buildTrackPositions(segment.points, exaggeration));

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

	buildTrackTimelineLabels(segments, exaggeration);
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

function interpolateAtTime(
	points: TripTrackPoint[],
	targetMs: number,
	exaggeration: number,
) {
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
					THREE.MathUtils.lerp(start.terrainHeight, end.terrainHeight, t) *
						exaggeration +
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

function collectTimelineLabelAnchors(
	points: TripTrackPoint[],
	exaggeration: number,
): TimelineAnchor[] {
	if (points.length === 0) return [];

	const firstPoint = points[0]!;
	const lastPoint = points.at(-1)!;
	const anchors: TimelineAnchor[] = [];

	anchors.push({
		x: firstPoint.x,
		y: firstPoint.terrainHeight * exaggeration + TRACK_SURFACE_OFFSET + 28,
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
			const pos = interpolateAtTime(points, t, exaggeration);
			if (pos) anchors.push({ ...pos, time: t, kind: "hour" });
		}
	}

	anchors.push({
		x: lastPoint.x,
		y: lastPoint.terrainHeight * exaggeration + TRACK_SURFACE_OFFSET + 28,
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
		const timezone = tripBundle?.display.timezone;
		if (timezone) {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).formatToParts(new Date(time));
			const h = parts.find((p) => p.type === "hour")?.value ?? "00";
			return `${h}:00`;
		}
		return new Date(time).toISOString().slice(11, 16);
	}
	return formatIsoDateTime(time, tripBundle?.display.timezone);
}

function worldToHeightmapSample(
	metadata: TerrainMetadata,
	x: number,
	z: number,
) {
	const normalizedX = (x + metadata.sizeMeters.width / 2) / metadata.sizeMeters.width;
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

	const { metadata, heights, currentExaggeration } = terrainRuntime;
	const cameraPos = camera.position;
	const horizontalDistance = Math.hypot(worldPos.x - cameraPos.x, worldPos.z - cameraPos.z);
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
		const terrainHeight =
			sampleHeightBilinear(
				heights,
				metadata.width,
				metadata.height,
				terrainSample.x,
				terrainSample.y,
			) * currentExaggeration;
		const sightlineHeight = THREE.MathUtils.lerp(cameraPos.y, worldPos.y, t);
		if (terrainHeight > sightlineHeight - 6) {
			return true;
		}
	}

	return false;
}

function buildTrackTimelineLabels(
	segments: TripTrackSegment[],
	exaggeration: number,
) {
	clearTrackTimelineLabels();

	for (const segment of segments) {
		for (const anchor of collectTimelineLabelAnchors(
			segment.points,
			exaggeration,
		)) {
			const text = formatTimelineLabel(anchor.time, anchor.kind);
			if (!text) continue;

			const element = document.createElement("div");
			element.className = "trip-track-label";
			element.textContent = text;
			element.hidden = true;
			viewerOverlay.append(element);

			const anchorObject = new THREE.Object3D();
			anchorObject.position.set(anchor.x, anchor.y, anchor.z);
			scene.add(anchorObject);

			trackTimelineLabels.push({
				anchor: anchorObject,
				element,
			});
		}
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
	captureTime: string | null,
) {
	const dateLabel = formatIsoDateTime(
		captureTime,
		tripBundle?.display.timezone,
	);
	const hasDescription = Boolean(description && description.trim().length > 0);
	const lines = [
		hasDescription ? (description?.trim() ?? null) : null,
		dateLabel,
	].filter((value): value is string => Boolean(value));

	if (lines.length === 0) {
		return;
	}

	const blockHeight = hasDescription ? 114 : 74;
	context.fillStyle = "rgba(12, 18, 21, 0.54)";
	context.fillRect(0, height - blockHeight, width, blockHeight);

	if (hasDescription) {
		context.fillStyle = "#fff6dd";
		context.font = "600 28px Georgia";
		context.fillText(lines[0], 28, height - 64, width - 56);
	}

	if (dateLabel) {
		context.fillStyle = "rgba(255, 246, 221, 0.88)";
		context.font = hasDescription
			? "500 22px 'Avenir Next'"
			: "600 26px 'Avenir Next'";
		context.fillText(
			dateLabel,
			28,
			hasDescription ? height - 28 : height - 32,
			width - 56,
		);
	}
}

async function loadTextureFromImage(
	imageUrl: string,
	description: string | null,
	captureTime: string | null,
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
	drawCardTextBlock(context, width, height, description, captureTime);
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
	exaggeration: number,
) {
	const group = new THREE.Group();
	group.position.set(cluster.x, 0, cluster.z);
	group.renderOrder = 30;

	const CARD_W = 250;
	const CARD_H = 164;
	const CARD_GAP = 10;
	const anchorY = cluster.terrainHeight * exaggeration + 6;
	const cardY = anchorY + cluster.cardHeight;
	const members = anchors.filter((anchor) => anchor.clusterId === cluster.id);
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
			index === 0 ? preview.captureTime : null,
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
		group.add(sprite);
	}

	return group;
}

async function renderClusters(
	clusters: TripCluster[],
	anchors: TripPhotoAnchor[],
	exaggeration: number,
) {
	for (const object of clusterObjects) {
		scene.remove(object);
	}
	clusterObjects.length = 0;

	for (const cluster of clusters) {
		const clusterObject = await buildClusterObject(
			cluster,
			anchors,
			exaggeration,
		);
		clusterObjects.push(clusterObject);
		scene.add(clusterObject);
	}
}

function focusScene(metadata: TerrainMetadata) {
	const maxSpan = Math.max(
		metadata.sizeMeters.width,
		metadata.sizeMeters.height,
	);
	const verticalRange =
		(metadata.elevationRange.max - metadata.elevationRange.min) *
		(terrainRuntime?.currentExaggeration ?? 1);

	camera.position.set(0, maxSpan * 0.48 + verticalRange, maxSpan * 0.82);
	controls.target.set(0, verticalRange * 0.15, 0);
	controls.maxDistance = maxSpan * 3.4;
	camera.near = 10;
	camera.far = maxSpan * 8;
	camera.updateProjectionMatrix();
	controls.update();
}

function zoomCamera(scale: number) {
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

function handleViewerKeyboard(event: KeyboardEvent) {
	if (document.activeElement !== canvas) {
		return;
	}

	if (!terrainRuntime) {
		return;
	}

	switch (event.key) {
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
	applyVerticalExaggeration(
		geometry,
		heights,
		metadata.defaultVerticalExaggeration,
	);

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
		currentExaggeration: metadata.defaultVerticalExaggeration,
	};

	renderTrackSegments(trip.trackSegments, terrainRuntime.currentExaggeration);
	await renderClusters(
		trip.clusters,
		trip.photoAnchors,
		terrainRuntime.currentExaggeration,
	);

	tripClusters.value = trip.clusters;
	tripPhotoAnchors.value = trip.photoAnchors;
	tripStats.value = trip.stats;
	resetVisible.value = true;

	focusScene(metadata);
	resizeRenderer();
	setStatus("Trip scene ready.");
}

function animate() {
	const deltaSeconds = Math.min(clock.getDelta(), 0.1);
	animationHandle = window.requestAnimationFrame(animate);
	updateKeyboardNavigation(deltaSeconds);
	controls.update();
	updateTrackTimelineLabels();
	renderer.render(scene, camera);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
	throw new Error("Application root was not found.");
}

render(<App />, app);

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

canvas.addEventListener("keydown", handleViewerKeyboard);
canvas.addEventListener("pointerdown", () => {
	canvas.focus({ preventScroll: true });
});
window.addEventListener("keydown", (event) => {
	if (!KEYBOARD_MOVE_CODES.has(event.code) || event.repeat) {
		return;
	}
	if (document.activeElement !== canvas) {
		return;
	}
	pressedKeys.add(event.code);
	event.preventDefault();
});
window.addEventListener("keyup", (event) => {
	pressedKeys.delete(event.code);
});
window.addEventListener("blur", () => {
	pressedKeys.clear();
});

const resizeObserver = new ResizeObserver(() => resizeRenderer());
resizeObserver.observe(canvas);
window.addEventListener("resize", resizeRenderer);

loadTerrainAndTrip().catch((error) => {
	setStatus(
		error instanceof Error ? error.message : "Trip scene failed to load.",
		true,
	);
});

resizeRenderer();
animate();

window.addEventListener("beforeunload", () => {
	window.cancelAnimationFrame(animationHandle);
	controls.dispose();
	renderer.dispose();
	for (const line of trackLines) {
		line.geometry.dispose();
		line.material.dispose();
	}
	for (const object of clusterObjects) {
		scene.remove(object);
	}
	clearTrackTimelineLabels();
	terrainRuntime?.mesh.material.map?.dispose();
	terrainRuntime?.mesh.material.dispose();
	terrainRuntime?.geometry.dispose();
});
