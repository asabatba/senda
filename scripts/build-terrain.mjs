import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromFile } from 'geotiff';

const DEFAULT_SOURCE = 'MDT02-WGS84-0178-2-COB2.tif';
const DEFAULT_MAX_EDGE = 1024;
const DEFAULT_VERTICAL_EXAGGERATION = 1.0;
const OUTPUT_DIR = path.join('public', 'data');
const OUTPUT_HEIGHTS = 'terrain-height.u16.bin';
const OUTPUT_METADATA = 'terrain.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseNoData(fileDirectory) {
  const rawValue = fileDirectory.GDAL_NODATA;
  if (rawValue === undefined || rawValue === null) {
    return -32767;
  }

  const parsed = Number.parseFloat(String(rawValue));
  return Number.isFinite(parsed) ? parsed : -32767;
}

function computeBounds(fileDirectory, sourceWidth, sourceHeight) {
  const [scaleX = 0, scaleY = 0] = fileDirectory.ModelPixelScale ?? [];
  const [rasterX = 0, rasterY = 0, , geoX = 0, geoY = 0] = fileDirectory.ModelTiepoint ?? [];

  if (!scaleX || !scaleY) {
    throw new Error('GeoTIFF is missing a valid ModelPixelScale tag.');
  }

  const west = geoX - rasterX * scaleX;
  const north = geoY + rasterY * scaleY;
  const east = west + sourceWidth * scaleX;
  const south = north - sourceHeight * scaleY;

  return { west, south, east, north };
}

function computeMetersPerDegree(latitude) {
  const radians = (latitude * Math.PI) / 180;
  const lat =
    111132.92 -
    559.82 * Math.cos(2 * radians) +
    1.175 * Math.cos(4 * radians) -
    0.0023 * Math.cos(6 * radians);
  const lon =
    111412.84 * Math.cos(radians) -
    93.5 * Math.cos(3 * radians) +
    0.118 * Math.cos(5 * radians);

  return { lat, lon };
}

function computeTerrainSize(bounds) {
  const centerLatitude = (bounds.north + bounds.south) / 2;
  const metersPerDegree = computeMetersPerDegree(centerLatitude);

  return {
    width: Math.abs(bounds.east - bounds.west) * metersPerDegree.lon,
    height: Math.abs(bounds.north - bounds.south) * metersPerDegree.lat,
  };
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

async function main() {
  const sourceFile = process.argv[2] ?? DEFAULT_SOURCE;
  const maxEdge = Number.parseInt(process.env.TERRAIN_MAX_EDGE ?? String(DEFAULT_MAX_EDGE), 10);
  if (!Number.isFinite(maxEdge) || maxEdge < 2) {
    throw new Error(`Invalid TERRAIN_MAX_EDGE value "${process.env.TERRAIN_MAX_EDGE}".`);
  }

  const sourcePath = path.resolve(repoRoot, sourceFile);
  const outputDir = path.resolve(repoRoot, OUTPUT_DIR);

  const tiff = await fromFile(sourcePath);
  const image = await tiff.getImage();
  const fileDirectory = image.fileDirectory;

  const sourceWidth = image.getWidth();
  const sourceHeight = image.getHeight();
  const samplesPerPixel = image.getSamplesPerPixel();

  if (samplesPerPixel !== 1) {
    throw new Error(`Expected a single-band DEM, received ${samplesPerPixel} samples per pixel.`);
  }

  const targetSize = computeTargetSize(sourceWidth, sourceHeight, maxEdge);
  const noDataValue = parseNoData(fileDirectory);
  const bounds = computeBounds(fileDirectory, sourceWidth, sourceHeight);
  const sizeMeters = computeTerrainSize(bounds);

  const raster = await image.readRasters({
    interleave: true,
    width: targetSize.width,
    height: targetSize.height,
    fillValue: noDataValue,
    // Nearest-neighbour avoids blending nodata into valid elevations at the raster edges.
    resampleMethod: 'nearest',
  });

  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;

  for (const value of raster) {
    if (isNoData(value, noDataValue)) {
      continue;
    }

    if (value < minElevation) {
      minElevation = value;
    }

    if (value > maxElevation) {
      maxElevation = value;
    }
  }

  if (!Number.isFinite(minElevation) || !Number.isFinite(maxElevation)) {
    throw new Error('The DEM did not contain any valid elevation values after resampling.');
  }

  const elevationSpan = Math.max(maxElevation - minElevation, 1e-6);
  const encodedHeights = new Uint16Array(raster.length);

  for (let index = 0; index < raster.length; index += 1) {
    const value = raster[index];
    if (isNoData(value, noDataValue)) {
      encodedHeights[index] = 0;
      continue;
    }

    const normalized = (value - minElevation) / elevationSpan;
    encodedHeights[index] = Math.min(65535, Math.max(1, Math.round(normalized * 65534) + 1));
  }

  const metadata = {
    sourceFile: path.basename(sourcePath),
    width: targetSize.width,
    height: targetSize.height,
    bounds,
    sizeMeters,
    elevationRange: {
      min: Number(minElevation.toFixed(3)),
      max: Number(maxElevation.toFixed(3)),
    },
    heightEncoding: {
      format: 'uint16',
      noDataCode: 0,
    },
    defaultVerticalExaggeration: DEFAULT_VERTICAL_EXAGGERATION,
    overlay: {
      url: null,
    },
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, OUTPUT_HEIGHTS),
    Buffer.from(encodedHeights.buffer, encodedHeights.byteOffset, encodedHeights.byteLength),
  );
  await fs.writeFile(path.join(outputDir, OUTPUT_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const footprintKm = {
    width: (sizeMeters.width / 1000).toFixed(2),
    height: (sizeMeters.height / 1000).toFixed(2),
  };

  console.log(
    JSON.stringify(
      {
        source: metadata.sourceFile,
        targetWidth: metadata.width,
        targetHeight: metadata.height,
        elevationRange: metadata.elevationRange,
        footprintKm,
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
