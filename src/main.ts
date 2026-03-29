import './style.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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
    format: 'uint16';
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
  metadata: TerrainMetadata;
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Application root was not found.');
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

const canvas = app.querySelector<HTMLCanvasElement>('canvas.viewer');
const statusNode = app.querySelector<HTMLElement>('[data-status]');
const controlsNode = app.querySelector<HTMLElement>('[data-controls]');
const statsNode = app.querySelector<HTMLElement>('[data-stats]');
const exaggerationInput = app.querySelector<HTMLInputElement>('[data-exaggeration]');
const exaggerationValue = app.querySelector<HTMLElement>('[data-exaggeration-value]');
const resetButton = app.querySelector<HTMLButtonElement>('[data-reset-camera]');
const sourceNode = app.querySelector<HTMLElement>('[data-source]');
const footprintNode = app.querySelector<HTMLElement>('[data-footprint]');
const elevationRangeNode = app.querySelector<HTMLElement>('[data-elevation-range]');
const boundsNode = app.querySelector<HTMLElement>('[data-bounds]');

if (
  !canvas ||
  !statusNode ||
  !controlsNode ||
  !statsNode ||
  !exaggerationInput ||
  !exaggerationValue ||
  !resetButton ||
  !sourceNode ||
  !footprintNode ||
  !elevationRangeNode ||
  !boundsNode
) {
  throw new Error('The terrain viewer UI failed to initialize.');
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
let terrainRuntime: TerrainRuntime | null = null;
let animationHandle = 0;

function formatBounds(bounds: TerrainMetadata['bounds']) {
  return `${bounds.west.toFixed(4)}, ${bounds.south.toFixed(4)} -> ${bounds.east.toFixed(4)}, ${bounds.north.toFixed(4)}`;
}

function formatDistance(value: number) {
  return `${(value / 1000).toFixed(2)} km`;
}

function decodeHeight(code: number, metadata: TerrainMetadata) {
  if (code === metadata.heightEncoding.noDataCode) {
    return metadata.elevationRange.min;
  }

  const normalized = (code - 1) / 65534;
  return metadata.elevationRange.min + normalized * (metadata.elevationRange.max - metadata.elevationRange.min);
}

function buildHeightArray(codes: Uint16Array, metadata: TerrainMetadata) {
  const heights = new Float32Array(codes.length);
  const baseElevation = metadata.elevationRange.min;

  for (let index = 0; index < codes.length; index += 1) {
    heights[index] = decodeHeight(codes[index], metadata) - baseElevation;
  }

  return heights;
}

function sampleHeight(heights: Float32Array, width: number, height: number, x: number, y: number) {
  const clampedX = Math.min(width - 1, Math.max(0, x));
  const clampedY = Math.min(height - 1, Math.max(0, y));
  return heights[clampedY * width + clampedX] ?? 0;
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
  const span = Math.max(metadata.elevationRange.max - metadata.elevationRange.min, 1e-6);
  const lightDirection = new THREE.Vector3(-0.35, 0.8, 0.48).normalize();

  for (let y = 0; y < metadata.height; y += 1) {
    for (let x = 0; x < metadata.width; x += 1) {
      const index = y * metadata.width + x;
      const heightValue = heights[index];
      const left = sampleHeight(heights, metadata.width, metadata.height, x - 1, y);
      const right = sampleHeight(heights, metadata.width, metadata.height, x + 1, y);
      const up = sampleHeight(heights, metadata.width, metadata.height, x, y - 1);
      const down = sampleHeight(heights, metadata.width, metadata.height, x, y + 1);

      const dx = right - left;
      const dz = down - up;
      const surfaceNormal = new THREE.Vector3(-dx, 28, -dz).normalize();
      const shading = THREE.MathUtils.clamp(surfaceNormal.dot(lightDirection), 0.18, 1);
      const normalizedHeight = THREE.MathUtils.clamp(heightValue / span, 0, 1);
      const color = rampColor(normalizedHeight);
      const brightness = 0.55 + shading * 0.55;

      pixels[index * 3] = Math.min(255, Math.round(color[0] * brightness));
      pixels[index * 3 + 1] = Math.min(255, Math.round(color[1] * brightness));
      pixels[index * 3 + 2] = Math.min(255, Math.round(color[2] * brightness));
    }
  }

  const texture = new THREE.DataTexture(pixels, metadata.width, metadata.height, THREE.RGBFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function applyVerticalExaggeration(geometry: THREE.PlaneGeometry, heights: Float32Array, factor: number) {
  const position = geometry.attributes.position;
  for (let index = 0; index < heights.length; index += 1) {
    position.setY(index, heights[index] * factor);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

async function buildSurfaceTexture(metadata: TerrainMetadata, heights: Float32Array) {
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

function resetCamera(metadata: TerrainMetadata, exaggeration: number) {
  const maxSpan = Math.max(metadata.sizeMeters.width, metadata.sizeMeters.height);
  const verticalRange = (metadata.elevationRange.max - metadata.elevationRange.min) * exaggeration;

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
}

function updateStats(metadata: TerrainMetadata) {
  sourceNode.textContent = metadata.sourceFile;
  footprintNode.textContent = `${formatDistance(metadata.sizeMeters.width)} x ${formatDistance(metadata.sizeMeters.height)}`;
  elevationRangeNode.textContent = `${metadata.elevationRange.min.toFixed(0)} m to ${metadata.elevationRange.max.toFixed(0)} m`;
  boundsNode.textContent = formatBounds(metadata.bounds);
}

async function loadTerrain() {
  statusNode.textContent = 'Loading terrain metadata...';
  const metadataResponse = await fetch('/data/terrain.json');
  if (!metadataResponse.ok) {
    throw new Error(`Terrain metadata request failed with ${metadataResponse.status}.`);
  }
  const metadata = (await metadataResponse.json()) as TerrainMetadata;

  statusNode.textContent = 'Loading terrain heightmap...';
  const heightResponse = await fetch('/data/terrain-height.u16.bin');
  if (!heightResponse.ok) {
    throw new Error(`Terrain height asset request failed with ${heightResponse.status}.`);
  }

  const rawHeightBuffer = await heightResponse.arrayBuffer();
  const expectedByteLength = metadata.width * metadata.height * Uint16Array.BYTES_PER_ELEMENT;
  if (rawHeightBuffer.byteLength !== expectedByteLength) {
    throw new Error(
      `Terrain height asset has ${rawHeightBuffer.byteLength} bytes, expected ${expectedByteLength}.`,
    );
  }

  statusNode.textContent = 'Preparing 3D terrain...';
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

  applyVerticalExaggeration(geometry, heights, metadata.defaultVerticalExaggeration);

  const material = new THREE.MeshStandardMaterial({
    map: surfaceTexture,
    roughness: 0.96,
    metalness: 0.02,
  });

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  const runtime: TerrainRuntime = {
    mesh,
    geometry,
    heights,
    metadata,
  };

  terrainRuntime = runtime;
  exaggerationInput.value = metadata.defaultVerticalExaggeration.toFixed(1);
  exaggerationValue.textContent = `${metadata.defaultVerticalExaggeration.toFixed(1)}x`;
  updateStats(metadata);
  resetCamera(metadata, metadata.defaultVerticalExaggeration);
  resizeRenderer();

  controlsNode.hidden = false;
  statsNode.hidden = false;
  statusNode.textContent = 'Terrain ready.';
}

function animate() {
  animationHandle = window.requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

exaggerationInput.addEventListener('input', () => {
  if (!terrainRuntime) {
    return;
  }

  const exaggeration = Number.parseFloat(exaggerationInput.value);
  applyVerticalExaggeration(terrainRuntime.geometry, terrainRuntime.heights, exaggeration);
  exaggerationValue.textContent = `${exaggeration.toFixed(1)}x`;
});

resetButton.addEventListener('click', () => {
  if (!terrainRuntime) {
    return;
  }

  const exaggeration = Number.parseFloat(exaggerationInput.value);
  resetCamera(terrainRuntime.metadata, exaggeration);
});

const resizeObserver = new ResizeObserver(() => resizeRenderer());
resizeObserver.observe(canvas);
window.addEventListener('resize', resizeRenderer);

loadTerrain().catch((error) => {
  statusNode.textContent = error instanceof Error ? error.message : 'Terrain loading failed.';
  statusNode.classList.add('status-error');
});

resizeRenderer();
animate();

window.addEventListener('beforeunload', () => {
  window.cancelAnimationFrame(animationHandle);
  controls.dispose();
  renderer.dispose();
});
