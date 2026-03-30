import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { fromFile } from 'geotiff';

const DATA_DIR = 'data';
const DEM_TILE_PATTERN = /^MDT02-ETRS89-HU31-.*\.tif$/i;
const ORTHOPHOTO_FILE = 'PNOA_MA_OF_ETRS89_HU31_h25_0178_2.tif';
const DEFAULT_MAX_EDGE = 1536;
const DEFAULT_VERTICAL_EXAGGERATION = 1.0;
const EXPECTED_EPSG = 25831;
const EXPECTED_RESOLUTION = 2;

const OUTPUT_DIR = path.join('public', 'data');
const OUTPUT_HEIGHTS = 'terrain-height.u16.bin.gz';
const OUTPUT_HEIGHTS_RAW = 'terrain-height.u16.bin';
const OUTPUT_METADATA = 'terrain.json';
const OUTPUT_ORTHO = 'terrain-ortho.rgba.bin.gz';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseNoData(image) {
  const rawValue = image.getGDALNoData?.();
  if (rawValue === undefined || rawValue === null) {
    return -32767;
  }

  const parsed = Number.parseFloat(String(rawValue));
  return Number.isFinite(parsed) ? parsed : -32767;
}

function assertProjectedCrs(image, label) {
  const geoKeys = image.getGeoKeys?.() ?? {};
  const epsg = Number(geoKeys.ProjectedCSTypeGeoKey);

  if (epsg !== EXPECTED_EPSG) {
    throw new Error(
      `${label} must be EPSG:${EXPECTED_EPSG}, received "${geoKeys.ProjectedCSTypeGeoKey ?? 'unknown'}".`,
    );
  }
}

function assertResolution(image, label) {
  const [resolutionX, resolutionY] = image.getResolution();
  if (Math.abs(resolutionX) !== EXPECTED_RESOLUTION || Math.abs(resolutionY) !== EXPECTED_RESOLUTION) {
    throw new Error(
      `${label} must have ${EXPECTED_RESOLUTION} m pixels, received ${resolutionX} x ${resolutionY}.`,
    );
  }
}

function assertRgbOrthophoto(image, label) {
  const samplesPerPixel = image.getSamplesPerPixel();
  if (samplesPerPixel < 3) {
    throw new Error(`${label} must have at least 3 samples per pixel, received ${samplesPerPixel}.`);
  }
}

function computeBounds(image) {
  const bbox = image.getBoundingBox?.();
  if (!bbox || bbox.length !== 4) {
    throw new Error('GeoTIFF is missing a valid bounding box.');
  }

  return {
    west: bbox[0],
    south: bbox[1],
    east: bbox[2],
    north: bbox[3],
  };
}

function expandBounds(accumulator, bounds) {
  return {
    west: Math.min(accumulator.west, bounds.west),
    south: Math.min(accumulator.south, bounds.south),
    east: Math.max(accumulator.east, bounds.east),
    north: Math.max(accumulator.north, bounds.north),
  };
}

function intersectBounds(a, b) {
  const overlap = {
    west: Math.max(a.west, b.west),
    south: Math.max(a.south, b.south),
    east: Math.min(a.east, b.east),
    north: Math.min(a.north, b.north),
  };

  if (overlap.east <= overlap.west || overlap.north <= overlap.south) {
    return null;
  }

  return overlap;
}

function computeTargetSize(sourceWidth, sourceHeight, maxEdge) {
  if (sourceWidth >= sourceHeight) {
    return {
      width: maxEdge,
      height: Math.max(2, Math.round((sourceHeight / sourceWidth) * maxEdge)),
    };
  }

  return {
    width: Math.max(2, Math.round((sourceWidth / sourceHeight) * maxEdge)),
    height: maxEdge,
  };
}

function isNoData(value, noDataValue) {
  return !Number.isFinite(value) || Object.is(value, noDataValue) || Math.abs(value - noDataValue) < 1e-6;
}

function computeDestinationWindow(tileBounds, mergedBounds, targetSize) {
  const mergedWidth = mergedBounds.east - mergedBounds.west;
  const mergedHeight = mergedBounds.north - mergedBounds.south;

  const colStart = Math.max(
    0,
    Math.min(targetSize.width - 1, Math.floor(((tileBounds.west - mergedBounds.west) / mergedWidth) * targetSize.width)),
  );
  const colEnd = Math.max(
    colStart + 1,
    Math.min(targetSize.width, Math.ceil(((tileBounds.east - mergedBounds.west) / mergedWidth) * targetSize.width)),
  );
  const rowStart = Math.max(
    0,
    Math.min(
      targetSize.height - 1,
      Math.floor(((mergedBounds.north - tileBounds.north) / mergedHeight) * targetSize.height),
    ),
  );
  const rowEnd = Math.max(
    rowStart + 1,
    Math.min(
      targetSize.height,
      Math.ceil(((mergedBounds.north - tileBounds.south) / mergedHeight) * targetSize.height),
    ),
  );

  return {
    colStart,
    colEnd,
    rowStart,
    rowEnd,
    width: colEnd - colStart,
    height: rowEnd - rowStart,
  };
}

function computeSourceWindowForBounds(image, imageBounds, bounds) {
  const [resolutionX, resolutionY] = image.getResolution();
  const pixelWidth = Math.abs(resolutionX);
  const pixelHeight = Math.abs(resolutionY);
  const imageWidth = image.getWidth();
  const imageHeight = image.getHeight();

  const left = clamp(
    Math.floor((bounds.west - imageBounds.west) / pixelWidth),
    0,
    imageWidth - 1,
  );
  const right = clamp(
    Math.ceil((bounds.east - imageBounds.west) / pixelWidth),
    left + 1,
    imageWidth,
  );
  const top = clamp(
    Math.floor((imageBounds.north - bounds.north) / pixelHeight),
    0,
    imageHeight - 1,
  );
  const bottom = clamp(
    Math.ceil((imageBounds.north - bounds.south) / pixelHeight),
    top + 1,
    imageHeight,
  );

  return [left, top, right, bottom];
}

async function discoverTiles() {
  const dataDir = path.resolve(repoRoot, DATA_DIR);
  const entries = await fs.readdir(dataDir);
  const tileNames = entries.filter((name) => DEM_TILE_PATTERN.test(name)).sort();

  if (tileNames.length === 0) {
    throw new Error(`No DEM tiles matching ${DEM_TILE_PATTERN} were found in "${DATA_DIR}".`);
  }

  const tiles = [];
  let mergedBounds = null;
  let noDataValue = null;

  for (const tileName of tileNames) {
    const tilePath = path.join(dataDir, tileName);
    const image = await (await fromFile(tilePath)).getImage();

    assertProjectedCrs(image, tileName);
    assertResolution(image, tileName);

    if (image.getSamplesPerPixel() !== 1) {
      throw new Error(`${tileName} must be single-band, received ${image.getSamplesPerPixel()} samples per pixel.`);
    }

    const tileNoData = parseNoData(image);
    if (noDataValue === null) {
      noDataValue = tileNoData;
    } else if (Math.abs(tileNoData - noDataValue) > 1e-6) {
      throw new Error(`${tileName} uses nodata ${tileNoData}, expected ${noDataValue}.`);
    }

    const bounds = computeBounds(image);
    mergedBounds = mergedBounds ? expandBounds(mergedBounds, bounds) : bounds;

    tiles.push({
      name: tileName,
      path: tilePath,
      image,
      bounds,
    });
  }

  return {
    tiles,
    mergedBounds,
    noDataValue,
  };
}

async function discoverOrthophoto() {
  const dataDir = path.resolve(repoRoot, DATA_DIR);
  const orthophotoPath = path.join(dataDir, ORTHOPHOTO_FILE);

  await fs.access(orthophotoPath);

  const image = await (await fromFile(orthophotoPath)).getImage();
  assertProjectedCrs(image, ORTHOPHOTO_FILE);
  assertRgbOrthophoto(image, ORTHOPHOTO_FILE);

  return {
    name: ORTHOPHOTO_FILE,
    path: orthophotoPath,
    image,
    bounds: computeBounds(image),
  };
}

async function buildOrthophotoAsset(orthophoto, mergedBounds, targetSize) {
  const coverageBounds = intersectBounds(mergedBounds, orthophoto.bounds);
  if (!coverageBounds) {
    return null;
  }

  const destinationWindow = computeDestinationWindow(coverageBounds, mergedBounds, targetSize);
  const sourceWindow = computeSourceWindowForBounds(orthophoto.image, orthophoto.bounds, coverageBounds);
  const rgb = await orthophoto.image.readRGB({
    window: sourceWindow,
    width: destinationWindow.width,
    height: destinationWindow.height,
    interleave: true,
    resampleMethod: 'bilinear',
  });

  const rgba = new Uint8Array(targetSize.width * targetSize.height * 4);

  for (let row = 0; row < destinationWindow.height; row += 1) {
    const sourceOffset = row * destinationWindow.width * 3;
    const destinationOffset =
      ((destinationWindow.rowStart + row) * targetSize.width + destinationWindow.colStart) * 4;

    for (let col = 0; col < destinationWindow.width; col += 1) {
      const rgbOffset = sourceOffset + col * 3;
      const rgbaOffset = destinationOffset + col * 4;
      rgba[rgbaOffset] = rgb[rgbOffset];
      rgba[rgbaOffset + 1] = rgb[rgbOffset + 1];
      rgba[rgbaOffset + 2] = rgb[rgbOffset + 2];
      rgba[rgbaOffset + 3] = 255;
    }
  }

  const rgbaBuffer = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const gzippedRgba = gzipSync(rgbaBuffer, { level: 9 });

  return {
    bytes: gzippedRgba,
    metadata: {
      url: OUTPUT_ORTHO,
      format: 'rgba8',
      compression: 'gzip',
      sourceFile: orthophoto.name,
      coverageBounds,
    },
  };
}

async function main() {
  const maxEdge = Number.parseInt(process.env.TERRAIN_MAX_EDGE ?? String(DEFAULT_MAX_EDGE), 10);
  if (!Number.isFinite(maxEdge) || maxEdge < 2) {
    throw new Error(`Invalid TERRAIN_MAX_EDGE value "${process.env.TERRAIN_MAX_EDGE}".`);
  }

  const outputDir = path.resolve(repoRoot, OUTPUT_DIR);
  const { tiles, mergedBounds, noDataValue } = await discoverTiles();
  const orthophoto = await discoverOrthophoto();
  const sourceWidth = Math.round((mergedBounds.east - mergedBounds.west) / EXPECTED_RESOLUTION);
  const sourceHeight = Math.round((mergedBounds.north - mergedBounds.south) / EXPECTED_RESOLUTION);
  const targetSize = computeTargetSize(sourceWidth, sourceHeight, maxEdge);

  const mergedRaster = new Float32Array(targetSize.width * targetSize.height);
  const validMask = new Uint8Array(targetSize.width * targetSize.height);

  for (const tile of tiles) {
    const window = computeDestinationWindow(tile.bounds, mergedBounds, targetSize);
    const raster = await tile.image.readRasters({
      interleave: true,
      width: window.width,
      height: window.height,
      fillValue: noDataValue,
      resampleMethod: 'nearest',
    });

    for (let row = 0; row < window.height; row += 1) {
      const sourceOffset = row * window.width;
      const destinationOffset = (window.rowStart + row) * targetSize.width + window.colStart;

      for (let col = 0; col < window.width; col += 1) {
        const value = raster[sourceOffset + col];
        if (isNoData(value, noDataValue)) {
          continue;
        }

        mergedRaster[destinationOffset + col] = value;
        validMask[destinationOffset + col] = 1;
      }
    }
  }

  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < mergedRaster.length; index += 1) {
    if (!validMask[index]) {
      continue;
    }

    const value = mergedRaster[index];
    if (value < minElevation) {
      minElevation = value;
    }
    if (value > maxElevation) {
      maxElevation = value;
    }
  }

  if (!Number.isFinite(minElevation) || !Number.isFinite(maxElevation)) {
    throw new Error('The merged DEM mosaic does not contain any valid elevation values.');
  }

  const elevationSpan = Math.max(maxElevation - minElevation, 1e-6);
  const encodedHeights = new Uint16Array(mergedRaster.length);

  for (let index = 0; index < mergedRaster.length; index += 1) {
    if (!validMask[index]) {
      encodedHeights[index] = 0;
      continue;
    }

    const normalized = (mergedRaster[index] - minElevation) / elevationSpan;
    encodedHeights[index] = Math.min(65535, Math.max(1, Math.round(normalized * 65534) + 1));
  }

  const orthophotoAsset = await buildOrthophotoAsset(orthophoto, mergedBounds, targetSize);
  const heightBuffer = Buffer.from(encodedHeights.buffer, encodedHeights.byteOffset, encodedHeights.byteLength);
  const gzippedHeights = gzipSync(heightBuffer, { level: 9 });

  const metadata = {
    sourceFiles: tiles.map((tile) => tile.name),
    width: targetSize.width,
    height: targetSize.height,
    crs: {
      epsg: EXPECTED_EPSG,
      kind: 'projected',
      units: 'meter',
    },
    bounds: mergedBounds,
    sizeMeters: {
      width: mergedBounds.east - mergedBounds.west,
      height: mergedBounds.north - mergedBounds.south,
    },
    elevationRange: {
      min: Number(minElevation.toFixed(3)),
      max: Number(maxElevation.toFixed(3)),
    },
    heightAsset: {
      url: OUTPUT_HEIGHTS,
      format: 'uint16',
      compression: 'gzip',
      noDataCode: 0,
    },
    orthophotoAsset: orthophotoAsset?.metadata ?? null,
    defaultVerticalExaggeration: DEFAULT_VERTICAL_EXAGGERATION,
    overlay: {
      url: null,
    },
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(path.join(outputDir, OUTPUT_HEIGHTS_RAW), { force: true });
  await fs.writeFile(path.join(outputDir, OUTPUT_HEIGHTS), gzippedHeights);
  await fs.writeFile(path.join(outputDir, OUTPUT_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  if (orthophotoAsset) {
    await fs.writeFile(path.join(outputDir, OUTPUT_ORTHO), orthophotoAsset.bytes);
  } else {
    await fs.rm(path.join(outputDir, OUTPUT_ORTHO), { force: true });
  }

  console.log(
    JSON.stringify(
      {
        sources: metadata.sourceFiles,
        targetWidth: metadata.width,
        targetHeight: metadata.height,
        sizeMeters: metadata.sizeMeters,
        elevationRange: metadata.elevationRange,
        gzippedHeightBytes: gzippedHeights.length,
        gzippedOrthophotoBytes: orthophotoAsset?.bytes.length ?? 0,
        orthophotoCoverageBounds: orthophotoAsset?.metadata.coverageBounds ?? null,
        outputDir: path.relative(repoRoot, outputDir),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
