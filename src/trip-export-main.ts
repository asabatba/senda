import "./trip-export.css";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import { inflateBinaryAsset } from "./terrain/assets";
import { TRACK_SURFACE_OFFSET } from "./terrain/constants";
import { applyVerticalExaggeration, buildHeightArray } from "./terrain/heights";
import { buildSurfaceTexture } from "./terrain/texture";
import type { OrthophotoPresetId, TerrainMetadata } from "./terrain/types";

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
	mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
	currentExaggeration: number;
};

type TrackTimelineLabel = {
	x: number;
	y: number;
	z: number;
	text: string;
	element: HTMLDivElement;
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
	throw new Error("Application root was not found.");
}

app.innerHTML = `
  <div class="trip-layout">
    <section class="trip-viewer-shell">
      <canvas class="trip-viewer" aria-label="Trip scene export" tabindex="0"></canvas>
      <div class="trip-viewer-overlay"></div>
      <div class="trip-viewer-hint">
        <strong>Trip Scene</strong>
        <span>Mouse or touch to inspect the route. Focus the scene for keyboard orbit, pan, zoom, and reset.</span>
      </div>
    </section>
    <aside class="trip-panel">
      <p class="trip-eyebrow">Standalone Export</p>
      <h1 class="trip-title">Trip Scene</h1>
      <p class="trip-lede">Terrain, orthophoto, route line, and photo clusters are prepacked into this self-contained scene.</p>
      <p class="trip-status" data-status>Loading trip bundle...</p>
      <dl class="trip-stats" data-stats hidden>
        <div><dt>Tracks</dt><dd data-track-count></dd></div>
        <div><dt>Photos</dt><dd data-photo-count></dd></div>
        <div><dt>Clusters</dt><dd data-cluster-count></dd></div>
      </dl>
      <section class="trip-cluster-section" data-cluster-section hidden>
        <div class="trip-cluster-header">
          <span>Photo Clusters</span>
          <strong data-cluster-badge></strong>
        </div>
        <ul class="trip-cluster-list" data-cluster-list></ul>
      </section>
      <button class="trip-reset-button" type="button" data-reset-camera hidden>Reset camera</button>
    </aside>
  </div>
`;

const canvas = app.querySelector<HTMLCanvasElement>(".trip-viewer");
const viewerOverlay = app.querySelector<HTMLElement>(".trip-viewer-overlay");
const statusNode = app.querySelector<HTMLElement>("[data-status]");
const statsNode = app.querySelector<HTMLElement>("[data-stats]");
const trackCountNode = app.querySelector<HTMLElement>("[data-track-count]");
const photoCountNode = app.querySelector<HTMLElement>("[data-photo-count]");
const clusterCountNode = app.querySelector<HTMLElement>("[data-cluster-count]");
const clusterSectionNode = app.querySelector<HTMLElement>(
	"[data-cluster-section]",
);
const clusterBadgeNode = app.querySelector<HTMLElement>("[data-cluster-badge]");
const clusterListNode = app.querySelector<HTMLUListElement>(
	"[data-cluster-list]",
);
const resetButton = app.querySelector<HTMLButtonElement>("[data-reset-camera]");

if (
	!canvas ||
	!viewerOverlay ||
	!statusNode ||
	!statsNode ||
	!trackCountNode ||
	!photoCountNode ||
	!clusterCountNode ||
	!clusterSectionNode ||
	!clusterBadgeNode ||
	!clusterListNode ||
	!resetButton
) {
	throw new Error("Trip export UI failed to initialize.");
}

const renderer = new THREE.WebGLRenderer({
	canvas,
	antialias: true,
	alpha: true,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcbd7e2, 7000, 34000);

const camera = new THREE.PerspectiveCamera(44, 1, 10, 120000);
const controls = new OrbitControls(camera, renderer.domElement);
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

const trackLines: Line2[] = [];
const clusterObjects: THREE.Object3D[] = [];
const trackTimelineLabels: TrackTimelineLabel[] = [];

let terrainRuntime: TerrainRuntime | null = null;
let tripBundle: TripBundle | null = null;
let animationHandle = 0;

const KEYBOARD_ORBIT_STEP = 0.08;
const KEYBOARD_ZOOM_FACTOR = 1.16;
const KEYBOARD_PAN_STEP_RATIO = 0.04;

function setStatus(message: string, isError = false) {
	statusNode.textContent = message;
	statusNode.classList.toggle("trip-status-error", isError);
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

	for (const segment of segments) {
		const geometry = new LineGeometry();
		geometry.setPositions(buildTrackPositions(segment.points, exaggeration));

		const material = new LineMaterial({
			color: "#ff8d5d",
			linewidth: 4,
			transparent: true,
			opacity: 0.96,
			depthWrite: false,
			depthTest: false,
		});
		material.resolution.set(canvas.clientWidth, canvas.clientHeight);

		const line = new Line2(geometry, material);
		line.computeLineDistances();
		line.frustumCulled = false;
		line.renderOrder = 12;
		scene.add(line);
		trackLines.push(line);
	}

	buildTrackTimelineLabels(segments);
}

function formatIsoDateTime(value: string | number | null) {
	if (value === null) {
		return null;
	}

	const parsed =
		typeof value === "number" ? value : Date.parse(value);
	if (Number.isNaN(parsed)) {
		return typeof value === "string" ? value : null;
	}

	return new Date(parsed).toISOString().slice(0, 19).replace("T", " ");
}

function clearTrackTimelineLabels() {
	for (const label of trackTimelineLabels) {
		label.element.remove();
	}
	trackTimelineLabels.length = 0;
}

function interpolateTimelinePoint(
	start: TripTrackPoint,
	end: TripTrackPoint,
	targetDistanceKm: number,
) {
	const distanceSpan = end.distanceKm - start.distanceKm;
	const t =
		distanceSpan <= 1e-9
			? 0
			: (targetDistanceKm - start.distanceKm) / distanceSpan;

	return {
		x: THREE.MathUtils.lerp(start.x, end.x, t),
		y:
			THREE.MathUtils.lerp(start.terrainHeight, end.terrainHeight, t) +
			TRACK_SURFACE_OFFSET + 28,
		z: THREE.MathUtils.lerp(start.z, end.z, t),
		time:
			start.time !== null && end.time !== null
				? Math.round(THREE.MathUtils.lerp(start.time, end.time, t))
				: start.time ?? end.time ?? null,
	};
}

function collectTimelineLabelAnchors(segments: TripTrackSegment[]) {
	const orderedPoints = segments.flatMap((segment) => segment.points);
	if (orderedPoints.length === 0) {
		return [];
	}

	const anchors: Array<{
		x: number;
		y: number;
		z: number;
		time: number | null;
		distanceKm: number;
	}> = [];

	const firstPoint = orderedPoints[0];
	anchors.push({
		x: firstPoint.x,
		y: firstPoint.terrainHeight + TRACK_SURFACE_OFFSET + 28,
		z: firstPoint.z,
		time: firstPoint.time,
		distanceKm: firstPoint.distanceKm,
	});

	const totalDistance = orderedPoints.at(-1)?.distanceKm ?? 0;
	for (let targetDistanceKm = 5; targetDistanceKm < totalDistance; targetDistanceKm += 5) {
		for (let index = 1; index < orderedPoints.length; index += 1) {
			const start = orderedPoints[index - 1];
			const end = orderedPoints[index];
			if (
				start.distanceKm <= targetDistanceKm &&
				end.distanceKm >= targetDistanceKm
			) {
				const interpolated = interpolateTimelinePoint(
					start,
					end,
					targetDistanceKm,
				);
				anchors.push({
					...interpolated,
					distanceKm: targetDistanceKm,
				});
				break;
			}
		}
	}

	const lastPoint = orderedPoints.at(-1);
	const previousDistance = anchors.at(-1)?.distanceKm ?? 0;
	if (lastPoint && totalDistance - previousDistance >= 4) {
		anchors.push({
			x: lastPoint.x,
			y: lastPoint.terrainHeight + TRACK_SURFACE_OFFSET + 28,
			z: lastPoint.z,
			time: lastPoint.time,
			distanceKm: lastPoint.distanceKm,
		});
	}

	return anchors;
}

function buildTrackTimelineLabels(segments: TripTrackSegment[]) {
	clearTrackTimelineLabels();

	for (const anchor of collectTimelineLabelAnchors(segments)) {
		const text = formatIsoDateTime(anchor.time);
		if (!text) {
			continue;
		}

		const element = document.createElement("div");
		element.className = "trip-track-label";
		element.textContent = text;
		element.hidden = true;
		viewerOverlay.append(element);
		trackTimelineLabels.push({
			x: anchor.x,
			y: anchor.y,
			z: anchor.z,
			text,
			element,
		});
	}
}

function updateTrackTimelineLabels() {
	if (trackTimelineLabels.length === 0) {
		return;
	}

	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	if (!width || !height) {
		return;
	}

	for (const label of trackTimelineLabels) {
		const projected = new THREE.Vector3(label.x, label.y, label.z).project(camera);
		const visible =
			projected.z >= -1 &&
			projected.z <= 1 &&
			projected.x >= -1.08 &&
			projected.x <= 1.08 &&
			projected.y >= -1.08 &&
			projected.y <= 1.08;

		label.element.hidden = !visible;
		if (!visible) {
			continue;
		}

		const screenX = ((projected.x + 1) / 2) * width;
		const screenY = ((1 - projected.y) / 2) * height;
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
	const dateLabel = formatIsoDateTime(captureTime);
	const hasDescription = Boolean(description && description.trim().length > 0);
	const lines = [
		hasDescription ? description?.trim() ?? null : null,
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
		context.font = hasDescription ? "500 22px 'Avenir Next'" : "600 26px 'Avenir Next'";
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
			depthTest: false,
			depthWrite: false,
		}),
	);
	marker.position.set(0, anchorY, 0);
	marker.renderOrder = 31;
	group.add(marker);

	const lineGeometry = new THREE.BufferGeometry().setFromPoints([
		new THREE.Vector3(0, anchorY + 10, 0),
		new THREE.Vector3(0, cardY - 78, 0),
	]);
	const line = new THREE.Line(
		lineGeometry,
		new THREE.LineBasicMaterial({
			color: 0xf2d39a,
			transparent: true,
			opacity: 0.9,
			depthTest: false,
			depthWrite: false,
		}),
	);
	line.renderOrder = 31;
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
				depthTest: false,
			}),
		);
		sprite.scale.set(250, 164, 1);
		sprite.position.set(index * 14 - 12, cardY + index * 14, -index * 10);
		sprite.renderOrder = 32;
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

function orbitCamera(deltaAzimuth: number, deltaPolar: number) {
	const offset = camera.position.clone().sub(controls.target);
	const spherical = new THREE.Spherical().setFromVector3(offset);
	spherical.theta += deltaAzimuth;
	spherical.phi = THREE.MathUtils.clamp(
		spherical.phi + deltaPolar,
		0.0001,
		controls.maxPolarAngle,
	);
	offset.setFromSpherical(spherical);
	camera.position.copy(controls.target).add(offset);
	controls.update();
}

function panCamera(horizontal: number, depth: number) {
	const offset = camera.position.clone().sub(controls.target);
	const distance = Math.max(offset.length(), controls.minDistance);
	const panStep = Math.max(distance * KEYBOARD_PAN_STEP_RATIO, 30);
	const forward = controls.target.clone().sub(camera.position);
	forward.y = 0;
	if (forward.lengthSq() === 0) {
		forward.set(0, 0, -1);
	}
	forward.normalize();
	const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
	const translation = right
		.multiplyScalar(horizontal * panStep)
		.add(forward.multiplyScalar(depth * panStep));
	camera.position.add(translation);
	controls.target.add(translation);
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

function handleViewerKeyboard(event: KeyboardEvent) {
	if (document.activeElement !== canvas) {
		return;
	}

	if (!terrainRuntime) {
		return;
	}

	switch (event.key) {
		case "ArrowLeft":
			event.preventDefault();
			if (event.shiftKey) {
				panCamera(-1, 0);
			} else {
				orbitCamera(-KEYBOARD_ORBIT_STEP, 0);
			}
			return;
		case "ArrowRight":
			event.preventDefault();
			if (event.shiftKey) {
				panCamera(1, 0);
			} else {
				orbitCamera(KEYBOARD_ORBIT_STEP, 0);
			}
			return;
		case "ArrowUp":
			event.preventDefault();
			if (event.shiftKey) {
				panCamera(0, 1);
			} else {
				orbitCamera(0, -KEYBOARD_ORBIT_STEP);
			}
			return;
		case "ArrowDown":
			event.preventDefault();
			if (event.shiftKey) {
				panCamera(0, -1);
			} else {
				orbitCamera(0, KEYBOARD_ORBIT_STEP);
			}
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

function renderClusterList(trip: TripBundle) {
	clusterListNode.replaceChildren(
		...trip.clusters.map((cluster) => {
			const members = trip.photoAnchors.filter(
				(anchor) => anchor.clusterId === cluster.id,
			);
			const item = document.createElement("li");
			item.className = "trip-cluster-item";

			const title = document.createElement("strong");
			title.textContent =
				members.length === 1
					? members[0].sourceLabel
					: `${members.length} photos`;

			const meta = document.createElement("p");
			meta.textContent = members
				.slice(0, 3)
				.map((member) => member.description ?? member.sourceLabel)
				.join(" · ");

			item.append(title, meta);
			item.addEventListener("click", () => {
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
			});
			return item;
		}),
	);
	clusterSectionNode.hidden = trip.clusters.length === 0;
	clusterBadgeNode.textContent = String(trip.clusters.length);
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
	});
	const mesh = new THREE.Mesh(geometry, material);
	scene.add(mesh);

	terrainRuntime = {
		metadata,
		geometry,
		heights,
		mesh,
		currentExaggeration: metadata.defaultVerticalExaggeration,
	};

	renderTrackSegments(trip.trackSegments, terrainRuntime.currentExaggeration);
	await renderClusters(
		trip.clusters,
		trip.photoAnchors,
		terrainRuntime.currentExaggeration,
	);
	renderClusterList(trip);
	trackCountNode.textContent = String(trip.stats.trackCount);
	photoCountNode.textContent = String(trip.stats.imageCount);
	clusterCountNode.textContent = String(trip.stats.clusterCount);
	statsNode.hidden = false;
	resetButton.hidden = false;
	focusScene(metadata);
	resizeRenderer();
	setStatus("Trip scene ready.");
}

function animate() {
	animationHandle = window.requestAnimationFrame(animate);
	controls.update();
	updateTrackTimelineLabels();
	renderer.render(scene, camera);
}

resetButton.addEventListener("click", () => {
	if (terrainRuntime) {
		focusScene(terrainRuntime.metadata);
	}
});
canvas.addEventListener("keydown", handleViewerKeyboard);
canvas.addEventListener("pointerdown", () => {
	canvas.focus({ preventScroll: true });
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
