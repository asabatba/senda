import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const DEFAULT_OUT_DIR = ".trip-export";
const DEFAULT_CLUSTER_DISTANCE = 100;
const DEFAULT_CARD_HEIGHT = 280;
const DEFAULT_TRACK_PADDING_METERS = 2000;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);

main();

function main() {
	const repoRoot = process.cwd();
	const options = parseArgs(process.argv.slice(2));
	validateInputs(options);

	const terrain = loadTerrainDataset(repoRoot);
	const tracks = loadTracks(options.gpx, terrain);
	const imageDiscovery = discoverImages(options.images, repoRoot);
	const imageCandidates = imageDiscovery.files;
	validateImageDiscovery(options.images, imageDiscovery.unmatchedPatterns);
	const csvEntries = options.csv
		? parseImageCsv(resolve(repoRoot, options.csv))
		: [];
	const images = mergeImageInputs(
		imageCandidates,
		csvEntries,
		repoRoot,
		options.csv,
	);
	const timeOptions = {
		hourCorrection: options.imageTimeHourCorrection,
		timezone: options.timezone,
	};
	const placedImages = placeImages(
		images,
		csvEntries,
		tracks.lookup,
		terrain,
		timeOptions,
	);
	const clustered = clusterAnchors(
		placedImages,
		options.clusterDistance,
		options.cardHeight,
	);
	const terrainSubset = buildTerrainSubset(
		terrain,
		tracks.segments,
		options.trackPaddingMeters,
	);
	const rebasedTracks = rebaseTrackSegments(
		tracks.segments,
		terrain.metadata,
		terrainSubset.metadata,
	);
	const rebasedClusters = rebaseClusteredData(
		clustered,
		terrain.metadata,
		terrainSubset.metadata,
	);

	const outDir = resolve(repoRoot, options.outDir);
	const tempBuildDir = resolve(repoRoot, ".codex-tmp", "trip-export-build");
	prepareOutDir(outDir);
	const copiedImages = copyImages(rebasedClusters.anchors, outDir);
	const tripBundle = buildTripBundle(
		{ segments: rebasedTracks },
		rebasedClusters,
		copiedImages,
		terrainSubset.metadata.orthophoto.defaultPreset,
		options.cardHeight,
		options.timezone,
	);

	buildViewer(tempBuildDir, repoRoot);
	copyBuiltViewer(tempBuildDir, outDir);
	writeTerrainSubset(terrainSubset, outDir);
	writeFileSync(
		join(outDir, "trip.json"),
		`${JSON.stringify(tripBundle, null, "\t")}\n`,
		"utf8",
	);

	const summary = {
		gpxFiles: options.gpx.length,
		discoveredImages: imageCandidates.length,
		manifestRows: csvEntries.length,
		placedImages: rebasedClusters.anchors.length,
		clusterCount: rebasedClusters.clusters.length,
		unplacedImages: placedImages.unplaced.length,
		imageTimeHourCorrection: options.imageTimeHourCorrection,
		timezone: options.timezone,
		trackPaddingMeters: options.trackPaddingMeters,
		terrainSizeMeters: terrainSubset.metadata.sizeMeters,
		outDir: relative(repoRoot, outDir) || ".",
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	if (placedImages.unplaced.length > 0) {
		process.stderr.write(
			`${placedImages.unplaced.length} image(s) could not be placed:\n${placedImages.unplaced
				.map((entry) => `- ${entry.label}: ${entry.reason}`)
				.join("\n")}\n`,
		);
	}
}

function parseArgs(args) {
	const options = {
		gpx: [],
		images: [],
		csv: null,
		outDir: DEFAULT_OUT_DIR,
		clusterDistance: DEFAULT_CLUSTER_DISTANCE,
		cardHeight: DEFAULT_CARD_HEIGHT,
		imageTimeHourCorrection: 0,
		timezone: null,
		trackPaddingMeters: DEFAULT_TRACK_PADDING_METERS,
	};

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		const value = args[index + 1];
		if (token === "--gpx") {
			options.gpx.push(assertValue(token, value));
			index += 1;
			continue;
		}
		if (token === "--images") {
			options.images.push(assertValue(token, value));
			index += 1;
			continue;
		}
		if (token === "--csv") {
			options.csv = assertValue(token, value);
			index += 1;
			continue;
		}
		if (token === "--out-dir") {
			options.outDir = assertValue(token, value);
			index += 1;
			continue;
		}
		if (token === "--cluster-distance") {
			options.clusterDistance = parsePositiveNumber(token, value);
			index += 1;
			continue;
		}
		if (token === "--card-height") {
			options.cardHeight = parsePositiveNumber(token, value);
			index += 1;
			continue;
		}
		if (token === "--image-time-hour-correction") {
			options.imageTimeHourCorrection = parseNumber(token, value);
			index += 1;
			continue;
		}
		if (token === "--timezone") {
			options.timezone = assertValue(token, value);
			index += 1;
			continue;
		}
		if (token === "--track-padding-meters") {
			options.trackPaddingMeters = parsePositiveNumber(token, value);
			index += 1;
			continue;
		}
		if (token === "--help" || token === "-h") {
			process.stdout.write(
				[
					"Usage: pnpm trip:build --gpx file.gpx [--gpx file2.gpx] [--images path|glob] [--csv manifest.csv]",
					"\t[--out-dir .trip-export] [--cluster-distance 60] [--card-height 280] [--track-padding-meters 1000]",
					"\t[--timezone Europe/Madrid] [--image-time-hour-correction 0]  (can be combined: timezone interprets naive EXIF/CSV times, hour-correction then shifts by N hours)",
				].join("\n") + "\n",
			);
			process.exit(0);
		}
		throw new Error(`Unknown argument ${token}.`);
	}

	return options;
}

function assertValue(flag, value) {
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value.`);
	}
	return value;
}

function parsePositiveNumber(flag, value) {
	const parsed = parseNumber(flag, value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive number.`);
	}
	return parsed;
}

function parseNumber(flag, value) {
	const parsed = Number.parseFloat(assertValue(flag, value));
	if (!Number.isFinite(parsed)) {
		throw new Error(`${flag} must be a number.`);
	}
	return parsed;
}

function validateInputs(options) {
	if (options.gpx.length === 0) {
		throw new Error("At least one --gpx file is required.");
	}
	if (options.timezone) {
		try {
			Intl.DateTimeFormat(undefined, { timeZone: options.timezone });
		} catch {
			throw new Error(
				`--timezone "${options.timezone}" is not a valid IANA time zone identifier.`,
			);
		}
	}
}

function loadTerrainDataset(repoRoot) {
	const terrainRoot = join(repoRoot, "public", "data");
	const metadataPath = join(terrainRoot, "terrain.json");
	if (!existsSync(metadataPath)) {
		throw new Error(
			'Terrain assets are missing. Run "pnpm terrain:build" first.',
		);
	}

	const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
	const defaultPresetId = metadata.orthophoto?.defaultPreset;
	const defaultPreset = metadata.orthophoto?.presets?.[defaultPresetId];
	if (!defaultPresetId || !defaultPreset) {
		throw new Error(
			"Terrain metadata does not define a default orthophoto preset.",
		);
	}

	const heightAssetPath = join(terrainRoot, metadata.heightAsset.url);
	const orthophotoPath = join(terrainRoot, defaultPreset.url);
	if (!existsSync(heightAssetPath) || !existsSync(orthophotoPath)) {
		throw new Error(
			'Terrain asset files are incomplete. Rebuild them with "pnpm terrain:build".',
		);
	}

	const rawHeightBytes =
		metadata.heightAsset.compression === "gzip"
			? gunzipSync(readFileSync(heightAssetPath))
			: readFileSync(heightAssetPath);
	const heightCodes = new Uint16Array(
		rawHeightBytes.buffer,
		rawHeightBytes.byteOffset,
		rawHeightBytes.byteLength / Uint16Array.BYTES_PER_ELEMENT,
	);
	const heights = buildHeightArray(heightCodes, metadata);

	return {
		root: terrainRoot,
		metadataPath,
		heightAssetPath,
		orthophotoPath,
		metadata,
		heightCodes,
		heights,
	};
}

function buildHeightArray(codes, metadata) {
	const heights = new Float32Array(codes.length);
	const span = metadata.elevationRange.max - metadata.elevationRange.min;
	for (let index = 0; index < codes.length; index += 1) {
		const code = codes[index];
		if (code === metadata.heightAsset.noDataCode) {
			heights[index] = 0;
			continue;
		}
		const normalized = (code - 1) / 65534;
		heights[index] = normalized * span;
	}
	return heights;
}

function sampleTerrainHeight(dataset, normalizedX, normalizedY) {
	const { metadata, heights, heightCodes } = dataset;
	const maxX = metadata.width - 1;
	const maxY = metadata.height - 1;
	const x = clamp(normalizedX * maxX, 0, maxX);
	const y = clamp(normalizedY * maxY, 0, maxY);
	const x0 = Math.floor(x);
	const x1 = Math.min(maxX, Math.ceil(x));
	const y0 = Math.floor(y);
	const y1 = Math.min(maxY, Math.ceil(y));
	const tx = x - x0;
	const ty = y - y0;
	const samples = [
		{ x: x0, y: y0, weight: (1 - tx) * (1 - ty) },
		{ x: x1, y: y0, weight: tx * (1 - ty) },
		{ x: x0, y: y1, weight: (1 - tx) * ty },
		{ x: x1, y: y1, weight: tx * ty },
	];

	let total = 0;
	let weight = 0;
	for (const sample of samples) {
		if (sample.weight <= 0) {
			continue;
		}
		const index = sample.y * metadata.width + sample.x;
		if (heightCodes[index] === metadata.heightAsset.noDataCode) {
			continue;
		}
		total += (heights[index] ?? 0) * sample.weight;
		weight += sample.weight;
	}
	if (weight === 0) {
		return null;
	}
	return total / weight;
}

function loadTracks(gpxPaths, terrain) {
	const segments = [];
	const lookupPoints = [];
	let globalDistanceKm = 0;
	let lookupSegmentIndex = 0;

	for (const rawPath of gpxPaths) {
		const pathValue = resolve(process.cwd(), rawPath);
		const xmlText = readFileSync(pathValue, "utf8");
		const parsedSegments = parseGpxSegments(xmlText);
		for (const segment of parsedSegments) {
			const lookupSegmentId = `${pathValue}#${lookupSegmentIndex}`;
			lookupSegmentIndex += 1;
			const projectedPoints = [];
			let previousPoint = null;
			for (const point of segment.points) {
				if (previousPoint) {
					globalDistanceKm += haversineKm(
						previousPoint.lat,
						previousPoint.lon,
						point.lat,
						point.lon,
					);
				}
				previousPoint = point;
				const projected = projectLatLonToTerrain(point.lat, point.lon, terrain);
				const lookupPoint = {
					lat: point.lat,
					lon: point.lon,
					time: point.time,
					distanceKm: globalDistanceKm,
					projected,
					segmentId: lookupSegmentId,
				};
				lookupPoints.push(lookupPoint);
				if (!projected) {
					continue;
				}
				projectedPoints.push({
					x: projected.x,
					z: projected.z,
					terrainHeight: projected.terrainHeight,
					distanceKm: globalDistanceKm,
					time: point.time,
				});
			}
			if (projectedPoints.length >= 2) {
				segments.push({
					name: basename(pathValue),
					points: projectedPoints,
				});
			}
		}
	}

	if (segments.length === 0) {
		throw new Error(
			"None of the GPX points fall inside the current terrain bounds.",
		);
	}

	return {
		segments,
		lookup: buildTrackLookup(lookupPoints),
	};
}

function parseGpxSegments(xmlText) {
	const segments = [];
	const segmentMatches = [
		...matchBlocks(xmlText, "trkseg").map((block) => ({
			tag: "trkpt",
			text: block,
		})),
		...matchBlocks(xmlText, "rte").map((block) => ({
			tag: "rtept",
			text: block,
		})),
	];

	for (const segmentMatch of segmentMatches) {
		const points = [];
		for (const rawPoint of matchSelfOrBlockTags(
			segmentMatch.text,
			segmentMatch.tag,
		)) {
			const attrs = rawPoint.attrs;
			const lat = Number.parseFloat(readAttribute(attrs, "lat"));
			const lon = Number.parseFloat(readAttribute(attrs, "lon"));
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
				continue;
			}

			const eleText = readTagText(rawPoint.body, "ele");
			const timeText = readTagText(rawPoint.body, "time");
			points.push({
				lat,
				lon,
				ele: eleText ? Number.parseFloat(eleText) : null,
				time: timeText ? Date.parse(timeText) : null,
			});
		}
		if (points.length > 0) {
			segments.push({ points });
		}
	}

	if (segments.length === 0) {
		throw new Error("The GPX file does not contain any track or route points.");
	}

	return segments;
}

function matchBlocks(text, tagName) {
	const regex = new RegExp(
		`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
		"gi",
	);
	const matches = [];
	let match = regex.exec(text);
	while (match) {
		matches.push(match[1] ?? "");
		match = regex.exec(text);
	}
	return matches;
}

function matchSelfOrBlockTags(text, tagName) {
	const regex = new RegExp(
		`<${tagName}\\b([^>]*?)(?:>([\\s\\S]*?)<\\/${tagName}>|\\s*\\/>)`,
		"gi",
	);
	const matches = [];
	let match = regex.exec(text);
	while (match) {
		matches.push({
			attrs: match[1] ?? "",
			body: match[2] ?? "",
		});
		match = regex.exec(text);
	}
	return matches;
}

function readAttribute(attrs, name) {
	const match = new RegExp(`${name}="([^"]+)"`, "i").exec(attrs);
	return match?.[1] ?? "";
}

function readTagText(text, tagName) {
	const match = new RegExp(
		`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
		"i",
	).exec(text);
	return match?.[1]?.trim() ?? null;
}

function buildTrackLookup(points) {
	const timedSegments = Array.from(
		points
			.filter((point) => typeof point.time === "number")
			.reduce((groups, point) => {
				const group = groups.get(point.segmentId) ?? [];
				group.push(point);
				groups.set(point.segmentId, group);
				return groups;
			}, new Map())
			.values(),
	)
		.map((segmentPoints) =>
			segmentPoints.sort((left, right) => (left.time ?? 0) - (right.time ?? 0)),
		)
		.filter((segmentPoints) => segmentPoints.length >= 2)
		.sort((left, right) => (left[0]?.time ?? 0) - (right[0]?.time ?? 0));

	return {
		points,
		timedSegments,
		interpolateByTime(targetTime) {
			if (timedSegments.length === 0) {
				return null;
			}
			for (const timedPoints of timedSegments) {
				if (
					targetTime < (timedPoints[0]?.time ?? Number.POSITIVE_INFINITY) ||
					targetTime > (timedPoints.at(-1)?.time ?? Number.NEGATIVE_INFINITY)
				) {
					continue;
				}
				for (let index = 1; index < timedPoints.length; index += 1) {
					const prev = timedPoints[index - 1];
					const next = timedPoints[index];
					if (
						(prev.time ?? 0) <= targetTime &&
						(next.time ?? 0) >= targetTime
					) {
						return interpolateTrackPoint(
							prev,
							next,
							(targetTime - prev.time) / Math.max(next.time - prev.time, 1),
						);
					}
				}
			}
			return null;
		},
		interpolateByDistance(distanceKm) {
			if (points.length < 2) {
				return null;
			}
			for (let index = 1; index < points.length; index += 1) {
				const prev = points[index - 1];
				const next = points[index];
				if (prev.distanceKm <= distanceKm && next.distanceKm >= distanceKm) {
					return interpolateTrackPoint(
						prev,
						next,
						(distanceKm - prev.distanceKm) /
							Math.max(next.distanceKm - prev.distanceKm, 1e-9),
					);
				}
			}
			return null;
		},
	};
}

function interpolateTrackPoint(prev, next, t) {
	return {
		lat: lerp(prev.lat, next.lat, t),
		lon: lerp(prev.lon, next.lon, t),
		time:
			typeof prev.time === "number" && typeof next.time === "number"
				? Math.round(lerp(prev.time, next.time, t))
				: null,
		distanceKm: lerp(prev.distanceKm, next.distanceKm, t),
		projected:
			prev.projected && next.projected
				? {
						x: lerp(prev.projected.x, next.projected.x, t),
						z: lerp(prev.projected.z, next.projected.z, t),
						terrainHeight: lerp(
							prev.projected.terrainHeight,
							next.projected.terrainHeight,
							t,
						),
					}
				: null,
	};
}

function discoverImages(patterns, repoRoot) {
	const discovered = new Map();
	const unmatchedPatterns = [];
	for (const pattern of patterns) {
		let matchedForPattern = 0;
		const resolvedPattern = isAbsolute(pattern)
			? pattern
			: resolve(repoRoot, pattern);
		if (!hasGlob(pattern) && existsSync(resolvedPattern)) {
			const stats = statSync(resolvedPattern);
			if (stats.isDirectory()) {
				for (const filePath of walkFiles(resolvedPattern)) {
					if (isImageFile(filePath)) {
						discovered.set(filePath, filePath);
						matchedForPattern += 1;
					}
				}
			} else if (stats.isFile() && isImageFile(resolvedPattern)) {
				discovered.set(resolvedPattern, resolvedPattern);
				matchedForPattern += 1;
			}
			if (matchedForPattern === 0) {
				unmatchedPatterns.push(pattern);
			}
			continue;
		}

		const baseDir = resolveGlobBase(resolvedPattern);
		if (!existsSync(baseDir)) {
			unmatchedPatterns.push(pattern);
			continue;
		}
		const regex = globToRegex(toPosixPath(relative(baseDir, resolvedPattern)));
		for (const filePath of walkFiles(baseDir)) {
			if (!isImageFile(filePath)) {
				continue;
			}
			const candidate = toPosixPath(relative(baseDir, filePath));
			if (regex.test(candidate)) {
				discovered.set(filePath, filePath);
				matchedForPattern += 1;
			}
		}
		if (matchedForPattern === 0) {
			unmatchedPatterns.push(pattern);
		}
	}
	return {
		files: Array.from(discovered.values()).sort(),
		unmatchedPatterns,
	};
}

function validateImageDiscovery(patterns, unmatchedPatterns) {
	if (patterns.length === 0 || unmatchedPatterns.length === 0) {
		return;
	}

	throw new Error(
		[
			`No image files matched: ${unmatchedPatterns.join(", ")}`,
			"If you are invoking this from PowerShell, quote the glob argument.",
			'Example: pnpm trip:build --gpx data/test/comodoto-mini.gpx --images "data/test/*.JPG"',
		].join("\n"),
	);
}

function mergeImageInputs(imagePaths, csvEntries, repoRoot, csvPath) {
	const imageRecords = new Map();
	for (const imagePath of imagePaths) {
		imageRecords.set(normalizeLookupKey(relative(repoRoot, imagePath)), {
			absolutePath: imagePath,
			label: relative(repoRoot, imagePath),
			exif: readImageExif(imagePath),
		});
	}

	for (const entry of csvEntries) {
		const resolved = resolveManifestImage(
			entry.image,
			repoRoot,
			csvPath,
			imagePaths,
		);
		if (!resolved) {
			continue;
		}
		const key = normalizeLookupKey(relative(repoRoot, resolved));
		if (!imageRecords.has(key)) {
			imageRecords.set(key, {
				absolutePath: resolved,
				label: relative(repoRoot, resolved),
				exif: readImageExif(resolved),
			});
		}
	}

	return Array.from(imageRecords.values());
}

function resolveManifestImage(imageValue, repoRoot, csvPath, imagePaths) {
	const trimmed = imageValue.trim();
	if (!trimmed) {
		return null;
	}
	const explicitPath = resolve(
		csvPath ? dirname(resolve(repoRoot, csvPath)) : repoRoot,
		trimmed,
	);
	if (existsSync(explicitPath) && statSync(explicitPath).isFile()) {
		return explicitPath;
	}

	const normalized = normalizeLookupKey(trimmed);
	const direct = imagePaths.find(
		(candidate) =>
			normalizeLookupKey(relative(repoRoot, candidate)) === normalized,
	);
	if (direct) {
		return direct;
	}

	const basenameMatch = imagePaths.filter(
		(candidate) =>
			normalizeLookupKey(basename(candidate)) ===
			normalizeLookupKey(basename(trimmed)),
	);
	return basenameMatch.length === 1 ? basenameMatch[0] : null;
}

function parseImageCsv(csvPath) {
	const rows = parseCsv(readFileSync(csvPath, "utf8"));
	return rows.map((row) => ({
		image: row.image ?? "",
		description: row.description?.trim() || null,
		time: row.time?.trim() || null,
		km: row.km?.trim() || null,
		lat: row.lat?.trim() || null,
		lon: row.lon?.trim() || null,
	}));
}

function parseCsv(text) {
	const rows = [];
	let field = "";
	let row = [];
	let inQuotes = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];
		if (char === '"') {
			if (inQuotes && next === '"') {
				field += '"';
				index += 1;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}
		if (!inQuotes && char === ",") {
			row.push(field);
			field = "";
			continue;
		}
		if (!inQuotes && (char === "\n" || char === "\r")) {
			if (char === "\r" && next === "\n") {
				index += 1;
			}
			row.push(field);
			field = "";
			if (row.some((value) => value !== "")) {
				rows.push(row);
			}
			row = [];
			continue;
		}
		field += char;
	}
	row.push(field);
	if (row.some((value) => value !== "")) {
		rows.push(row);
	}

	if (rows.length === 0) {
		return [];
	}

	const headers = rows[0].map((header) => header.trim().toLowerCase());
	return rows.slice(1).map((values) => {
		const result = {};
		for (let index = 0; index < headers.length; index += 1) {
			result[headers[index]] = values[index] ?? "";
		}
		return result;
	});
}

function placeImages(images, csvEntries, lookup, terrain, timeOptions) {
	const manifestMap = new Map();
	for (const entry of csvEntries) {
		if (!entry.image) {
			continue;
		}
		manifestMap.set(normalizeLookupKey(entry.image), entry);
	}

	const anchors = [];
	const unplaced = [];
	for (const image of images) {
		const manifest =
			manifestMap.get(normalizeLookupKey(image.label)) ??
			manifestMap.get(normalizeLookupKey(basename(image.absolutePath))) ??
			null;
		const resolved = resolveImagePlacement(
			image,
			manifest,
			lookup,
			terrain,
			timeOptions,
		);
		if (!resolved) {
			unplaced.push({
				label: image.label,
				reason:
					"missing coordinates and no matching GPX time/km interpolation target",
			});
			continue;
		}
		anchors.push({
			id: `photo-${anchors.length + 1}`,
			sourcePath: image.absolutePath,
			sourceLabel: image.label,
			description: manifest?.description ?? null,
			captureTime: resolved.captureTime ?? null,
			placedBy: resolved.placedBy,
			lat: resolved.lat,
			lon: resolved.lon,
			x: resolved.projected.x,
			z: resolved.projected.z,
			terrainHeight: resolved.projected.terrainHeight,
		});
	}

	anchors.sort((left, right) => {
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
	});
	return { anchors, unplaced };
}

function resolveImagePlacement(image, manifest, lookup, terrain, timeOptions) {
	const MAX_EXIF_GPS_TRACK_DISTANCE_METERS = 20;
	const adjustedExifCaptureTime = adjustTimestamp(
		image.exif.captureTime,
		timeOptions,
		true,
	);
	const csvTime = adjustTimestamp(manifest?.time ?? null, timeOptions, false);
	const csvTimeInterpolated = csvTime
		? lookup.interpolateByTime(Date.parse(csvTime))
		: null;
	const exifTimeInterpolated = adjustedExifCaptureTime
		? lookup.interpolateByTime(Date.parse(adjustedExifCaptureTime))
		: null;

	if (manifest?.lat && manifest?.lon) {
		const projected = projectLatLonToTerrain(
			Number.parseFloat(manifest.lat),
			Number.parseFloat(manifest.lon),
			terrain,
		);
		if (projected) {
			return {
				placedBy: "csv-coordinates",
				lat: Number.parseFloat(manifest.lat),
				lon: Number.parseFloat(manifest.lon),
				projected,
				captureTime: adjustTimestamp(manifest.time, timeOptions, false),
			};
		}
	}

	if (csvTimeInterpolated?.projected) {
		return {
			placedBy: "csv-time",
			lat: csvTimeInterpolated.lat,
			lon: csvTimeInterpolated.lon,
			projected: csvTimeInterpolated.projected,
			captureTime: csvTime,
		};
	}

	if (image.exif.lat !== null && image.exif.lon !== null) {
		const projected = projectLatLonToTerrain(
			image.exif.lat,
			image.exif.lon,
			terrain,
		);
		if (projected) {
			if (exifTimeInterpolated?.projected) {
				const exifDistanceFromTrack = distance2d(
					projected.x,
					projected.z,
					exifTimeInterpolated.projected.x,
					exifTimeInterpolated.projected.z,
				);
				if (exifDistanceFromTrack > MAX_EXIF_GPS_TRACK_DISTANCE_METERS) {
					return {
						placedBy: "exif-time",
						lat: exifTimeInterpolated.lat,
						lon: exifTimeInterpolated.lon,
						projected: exifTimeInterpolated.projected,
						captureTime: adjustedExifCaptureTime,
					};
				}
			}
			return {
				placedBy: "exif-gps",
				lat: image.exif.lat,
				lon: image.exif.lon,
				projected,
				captureTime: adjustedExifCaptureTime,
			};
		}
	}

	if (manifest?.km) {
		const interpolated = lookup.interpolateByDistance(
			Number.parseFloat(manifest.km),
		);
		if (interpolated?.projected) {
			return {
				placedBy: "csv-km",
				lat: interpolated.lat,
				lon: interpolated.lon,
				projected: interpolated.projected,
				captureTime: csvTime ?? adjustedExifCaptureTime,
			};
		}
	}

	if (exifTimeInterpolated?.projected) {
		return {
			placedBy: "exif-time",
			lat: exifTimeInterpolated.lat,
			lon: exifTimeInterpolated.lon,
			projected: exifTimeInterpolated.projected,
			captureTime: adjustedExifCaptureTime,
		};
	}

	return null;
}

function clusterAnchors(placementResult, clusterDistance, baseCardHeight) {
	const anchors = placementResult.anchors.map((anchor) => ({ ...anchor }));
	const clusters = [];

	for (const anchor of anchors) {
		let cluster = clusters.find(
			(candidate) =>
				distance2d(candidate.x, candidate.z, anchor.x, anchor.z) <=
				clusterDistance,
		);
		if (!cluster) {
			cluster = {
				id: `cluster-${clusters.length + 1}`,
				x: anchor.x,
				z: anchor.z,
				terrainHeight: anchor.terrainHeight,
				memberIds: [],
			};
			clusters.push(cluster);
		}
		cluster.memberIds.push(anchor.id);
		const members = cluster.memberIds
			.map((id) => anchors.find((entry) => entry.id === id))
			.filter(Boolean);
		cluster.x = average(members.map((entry) => entry.x));
		cluster.z = average(members.map((entry) => entry.z));
		cluster.terrainHeight = average(
			members.map((entry) => entry.terrainHeight),
		);
		anchor.clusterId = cluster.id;
	}

	for (const cluster of clusters) {
		cluster.cardHeight =
			baseCardHeight + Math.max(cluster.memberIds.length - 1, 0) * 42;
		cluster.memberIds.sort((leftId, rightId) => {
			const left = anchors.find((entry) => entry.id === leftId);
			const right = anchors.find((entry) => entry.id === rightId);
			return (left?.sourceLabel ?? "").localeCompare(right?.sourceLabel ?? "");
		});
	}

	return {
		anchors,
		clusters,
	};
}

function copyImages(anchors, outDir) {
	const imagesDir = join(outDir, "images");
	mkdirSync(imagesDir, { recursive: true });
	const copied = new Map();

	for (const anchor of anchors) {
		const extension = extname(anchor.sourcePath).toLowerCase() || ".jpg";
		const slug = sanitizeFileStem(
			basename(anchor.sourcePath, extname(anchor.sourcePath)),
		);
		let filename = `${slug}${extension}`;
		let counter = 2;
		while (copied.has(filename)) {
			filename = `${slug}-${counter}${extension}`;
			counter += 1;
		}
		copyFileSync(anchor.sourcePath, join(imagesDir, filename));
		copied.set(filename, true);
		copied.set(anchor.id, `./images/${filename}`);
	}

	return copied;
}

function buildTripBundle(
	tracks,
	clustered,
	copiedImages,
	defaultPresetId,
	cardHeight,
	timezone,
) {
	return {
		version: 1,
		title: "Trip Scene Export",
		terrain: {
			metadataUrl: "./terrain/terrain.json",
			defaultOrthophotoPreset: defaultPresetId,
		},
		display: {
			cardHeight,
			...(timezone ? { timezone } : {}),
		},
		stats: {
			trackCount: tracks.segments.length,
			imageCount: clustered.anchors.length,
			clusterCount: clustered.clusters.length,
		},
		trackSegments: tracks.segments,
		photoAnchors: clustered.anchors.map((anchor) => ({
			id: anchor.id,
			clusterId: anchor.clusterId,
			imageUrl: copiedImages.get(anchor.id),
			sourceLabel: anchor.sourceLabel,
			description: anchor.description,
			captureTime: anchor.captureTime,
			placedBy: anchor.placedBy,
			x: anchor.x,
			z: anchor.z,
			terrainHeight: anchor.terrainHeight,
		})),
		clusters: clustered.clusters.map((cluster) => ({
			id: cluster.id,
			x: cluster.x,
			z: cluster.z,
			terrainHeight: cluster.terrainHeight,
			cardHeight: cluster.cardHeight,
			memberIds: cluster.memberIds,
		})),
	};
}

function buildViewer(tempBuildDir, repoRoot) {
	rmSync(tempBuildDir, { recursive: true, force: true });
	const result = spawnSync(
		"pnpm",
		["exec", "vite", "build", "--outDir", tempBuildDir],
		{
			cwd: repoRoot,
			stdio: "inherit",
			shell: process.platform === "win32",
		},
	);
	if (result.status !== 0) {
		throw new Error("Vite build failed while packaging the trip viewer.");
	}
}

function prepareOutDir(outDir) {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
}

function copyBuiltViewer(tempBuildDir, outDir) {
	copyFileSync(
		join(tempBuildDir, "trip-export.html"),
		join(outDir, "index.html"),
	);
	copyDirectory(join(tempBuildDir, "assets"), join(outDir, "assets"));
}

function writeTerrainSubset(dataset, outDir) {
	const terrainDir = join(outDir, "terrain");
	mkdirSync(terrainDir, { recursive: true });
	writeFileSync(
		join(terrainDir, dataset.metadata.heightAsset.url),
		dataset.heightAssetBytes,
	);
	const defaultPresetId = dataset.metadata.orthophoto.defaultPreset;
	const defaultPreset = dataset.metadata.orthophoto.presets[defaultPresetId];
	writeFileSync(join(terrainDir, defaultPreset.url), dataset.orthophotoBytes);
	writeFileSync(
		join(terrainDir, "terrain.json"),
		`${JSON.stringify(dataset.metadata, null, "\t")}\n`,
		"utf8",
	);
}

function buildTerrainSubset(dataset, trackSegments, paddingMeters) {
	const cropBounds = computeTrackCropBounds(
		dataset.metadata,
		trackSegments,
		paddingMeters,
	);
	const heightWindow = computeRasterWindow(
		dataset.metadata.bounds,
		dataset.metadata.width,
		dataset.metadata.height,
		cropBounds,
	);
	const croppedHeightCodes = cropHeightCodes(
		dataset.heightCodes,
		dataset.metadata.width,
		heightWindow,
	);
	const croppedBounds = boundsFromWindow(
		dataset.metadata.bounds,
		dataset.metadata.width,
		dataset.metadata.height,
		heightWindow,
	);
	const rawHeightBytes = Buffer.from(
		croppedHeightCodes.buffer,
		croppedHeightCodes.byteOffset,
		croppedHeightCodes.byteLength,
	);

	const defaultPresetId = dataset.metadata.orthophoto.defaultPreset;
	const defaultPreset = dataset.metadata.orthophoto.presets[defaultPresetId];
	const orthophotoBounds = intersectBounds(
		croppedBounds,
		defaultPreset.coverageBounds,
	);
	const orthophotoWindow = computeRasterWindow(
		defaultPreset.coverageBounds,
		defaultPreset.width,
		defaultPreset.height,
		orthophotoBounds,
	);
	const rawOrthophotoBytes =
		defaultPreset.compression === "gzip"
			? gunzipSync(readFileSync(dataset.orthophotoPath))
			: readFileSync(dataset.orthophotoPath);
	const croppedOrthophotoBytes = cropRgbaPixels(
		rawOrthophotoBytes,
		defaultPreset.width,
		orthophotoWindow,
	);
	const croppedOrthophotoBounds = boundsFromWindow(
		defaultPreset.coverageBounds,
		defaultPreset.width,
		defaultPreset.height,
		orthophotoWindow,
	);

	return {
		metadata: {
			...dataset.metadata,
			width: heightWindow.width,
			height: heightWindow.height,
			bounds: croppedBounds,
			sizeMeters: {
				width: croppedBounds.east - croppedBounds.west,
				height: croppedBounds.north - croppedBounds.south,
			},
			orthophoto: {
				defaultPreset: defaultPresetId,
				presets: {
					[defaultPresetId]: {
						...defaultPreset,
						width: orthophotoWindow.width,
						height: orthophotoWindow.height,
						coverageBounds: croppedOrthophotoBounds,
					},
				},
			},
			namedPlaces: null,
			overlay: {
				url: null,
			},
		},
		heightAssetBytes:
			dataset.metadata.heightAsset.compression === "gzip"
				? gzipSync(rawHeightBytes)
				: rawHeightBytes,
		orthophotoBytes:
			defaultPreset.compression === "gzip"
				? gzipSync(croppedOrthophotoBytes)
				: croppedOrthophotoBytes,
	};
}

function computeTrackCropBounds(metadata, trackSegments, paddingMeters) {
	const center = getTerrainCenter(metadata);
	let west = Number.POSITIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;

	for (const segment of trackSegments) {
		for (const point of segment.points) {
			const projected = localToProjected(point.x, point.z, center);
			west = Math.min(west, projected.easting);
			south = Math.min(south, projected.northing);
			east = Math.max(east, projected.easting);
			north = Math.max(north, projected.northing);
		}
	}

	return {
		west: clamp(
			west - paddingMeters,
			metadata.bounds.west,
			metadata.bounds.east,
		),
		south: clamp(
			south - paddingMeters,
			metadata.bounds.south,
			metadata.bounds.north,
		),
		east: clamp(
			east + paddingMeters,
			metadata.bounds.west,
			metadata.bounds.east,
		),
		north: clamp(
			north + paddingMeters,
			metadata.bounds.south,
			metadata.bounds.north,
		),
	};
}

function computeRasterWindow(bounds, width, height, cropBounds) {
	const maxColumn = width - 1;
	const maxRow = height - 1;
	let colStart = clamp(
		Math.floor(
			((cropBounds.west - bounds.west) / (bounds.east - bounds.west)) *
				maxColumn,
		),
		0,
		maxColumn,
	);
	let colEnd = clamp(
		Math.ceil(
			((cropBounds.east - bounds.west) / (bounds.east - bounds.west)) *
				maxColumn,
		),
		0,
		maxColumn,
	);
	let rowStart = clamp(
		Math.floor(
			((bounds.north - cropBounds.north) / (bounds.north - bounds.south)) *
				maxRow,
		),
		0,
		maxRow,
	);
	let rowEnd = clamp(
		Math.ceil(
			((bounds.north - cropBounds.south) / (bounds.north - bounds.south)) *
				maxRow,
		),
		0,
		maxRow,
	);

	if (colEnd === colStart && width > 1) {
		if (colEnd < maxColumn) {
			colEnd += 1;
		} else {
			colStart -= 1;
		}
	}
	if (rowEnd === rowStart && height > 1) {
		if (rowEnd < maxRow) {
			rowEnd += 1;
		} else {
			rowStart -= 1;
		}
	}

	return {
		colStart,
		colEnd,
		rowStart,
		rowEnd,
		width: colEnd - colStart + 1,
		height: rowEnd - rowStart + 1,
	};
}

function cropHeightCodes(heightCodes, sourceWidth, window) {
	const cropped = new Uint16Array(window.width * window.height);
	for (let row = 0; row < window.height; row += 1) {
		const sourceStart = (window.rowStart + row) * sourceWidth + window.colStart;
		cropped.set(
			heightCodes.subarray(sourceStart, sourceStart + window.width),
			row * window.width,
		);
	}
	return cropped;
}

function cropRgbaPixels(bytes, sourceWidth, window) {
	const rowStride = sourceWidth * 4;
	const cropped = Buffer.alloc(window.width * window.height * 4);
	for (let row = 0; row < window.height; row += 1) {
		const sourceOffset =
			(window.rowStart + row) * rowStride + window.colStart * 4;
		bytes.copy(
			cropped,
			row * window.width * 4,
			sourceOffset,
			sourceOffset + window.width * 4,
		);
	}
	return cropped;
}

function boundsFromWindow(bounds, width, height, window) {
	const maxColumn = width - 1;
	const maxRow = height - 1;
	return {
		west:
			bounds.west + (window.colStart / maxColumn) * (bounds.east - bounds.west),
		south:
			bounds.north - (window.rowEnd / maxRow) * (bounds.north - bounds.south),
		east:
			bounds.west + (window.colEnd / maxColumn) * (bounds.east - bounds.west),
		north:
			bounds.north - (window.rowStart / maxRow) * (bounds.north - bounds.south),
	};
}

function intersectBounds(left, right) {
	const west = Math.max(left.west, right.west);
	const south = Math.max(left.south, right.south);
	const east = Math.min(left.east, right.east);
	const north = Math.min(left.north, right.north);
	return {
		west: Math.min(west, east),
		south: Math.min(south, north),
		east: Math.max(west, east),
		north: Math.max(south, north),
	};
}

function rebaseTrackSegments(trackSegments, originalMetadata, croppedMetadata) {
	return trackSegments.map((segment) => ({
		...segment,
		points: segment.points.map((point) => ({
			...point,
			...rebaseLocalPoint(point, originalMetadata, croppedMetadata),
		})),
	}));
}

function rebaseClusteredData(clustered, originalMetadata, croppedMetadata) {
	return {
		anchors: clustered.anchors.map((anchor) => ({
			...anchor,
			...rebaseLocalPoint(anchor, originalMetadata, croppedMetadata),
		})),
		clusters: clustered.clusters.map((cluster) => ({
			...cluster,
			...rebaseLocalPoint(cluster, originalMetadata, croppedMetadata),
		})),
	};
}

function rebaseLocalPoint(point, originalMetadata, croppedMetadata) {
	const originalCenter = getTerrainCenter(originalMetadata);
	const croppedCenter = getTerrainCenter(croppedMetadata);
	const projected = localToProjected(point.x, point.z, originalCenter);
	return projectedToLocal(projected.easting, projected.northing, croppedCenter);
}

function getTerrainCenter(metadata) {
	return {
		easting: (metadata.bounds.west + metadata.bounds.east) / 2,
		northing: (metadata.bounds.north + metadata.bounds.south) / 2,
	};
}

function localToProjected(x, z, center) {
	return {
		easting: center.easting + x,
		northing: center.northing - z,
	};
}

function projectedToLocal(easting, northing, center) {
	return {
		x: easting - center.easting,
		z: center.northing - northing,
	};
}

function projectLatLonToTerrain(lat, lon, dataset) {
	const { metadata } = dataset;
	const projected =
		metadata.crs.kind === "projected" && metadata.crs.epsg === 25831
			? latLonToUtm31(lat, lon)
			: { easting: lon, northing: lat };
	const normalizedX =
		(projected.easting - metadata.bounds.west) /
		(metadata.bounds.east - metadata.bounds.west);
	const normalizedY =
		(metadata.bounds.north - projected.northing) /
		(metadata.bounds.north - metadata.bounds.south);
	if (
		normalizedX < 0 ||
		normalizedX > 1 ||
		normalizedY < 0 ||
		normalizedY > 1
	) {
		return null;
	}
	const terrainHeight = sampleTerrainHeight(dataset, normalizedX, normalizedY);
	if (terrainHeight === null) {
		return null;
	}
	return {
		x: normalizedX * metadata.sizeMeters.width - metadata.sizeMeters.width / 2,
		z:
			normalizedY * metadata.sizeMeters.height - metadata.sizeMeters.height / 2,
		terrainHeight,
	};
}

function readImageExif(imagePath) {
	const extension = extname(imagePath).toLowerCase();
	if (extension !== ".jpg" && extension !== ".jpeg") {
		return { lat: null, lon: null, captureTime: null };
	}
	try {
		return parseExifFromJpeg(readFileSync(imagePath));
	} catch {
		return { lat: null, lon: null, captureTime: null };
	}
}

function parseExifFromJpeg(buffer) {
	let offset = 2;
	while (offset + 4 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			break;
		}
		const marker = buffer[offset + 1];
		if (marker === 0xda || marker === 0xd9) {
			break;
		}
		const length = buffer.readUInt16BE(offset + 2);
		if (
			marker === 0xe1 &&
			buffer.toString("ascii", offset + 4, offset + 10) === "Exif\u0000\u0000"
		) {
			return parseExifTiff(buffer.subarray(offset + 10, offset + 2 + length));
		}
		offset += 2 + length;
	}
	return { lat: null, lon: null, captureTime: null };
}

function parseExifTiff(buffer) {
	const littleEndian = buffer.toString("ascii", 0, 2) === "II";
	const readUint16 = (offset) =>
		littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
	const readUint32 = (offset) =>
		littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
	const readRational = (offset) =>
		readUint32(offset) / Math.max(readUint32(offset + 4), 1);
	const typeSize = new Map([
		[1, 1],
		[2, 1],
		[3, 2],
		[4, 4],
		[5, 8],
	]);

	function readIfdEntries(ifdOffset) {
		if (ifdOffset <= 0 || ifdOffset + 2 > buffer.length) {
			return new Map();
		}
		const count = readUint16(ifdOffset);
		const entries = new Map();
		for (let index = 0; index < count; index += 1) {
			const entryOffset = ifdOffset + 2 + index * 12;
			if (entryOffset + 12 > buffer.length) {
				break;
			}
			const tag = readUint16(entryOffset);
			const type = readUint16(entryOffset + 2);
			const valueCount = readUint32(entryOffset + 4);
			const bytes = (typeSize.get(type) ?? 1) * valueCount;
			const rawValueOffset = readUint32(entryOffset + 8);
			entries.set(tag, {
				type,
				valueCount,
				bytes,
				rawValueOffset,
				inlineOffset: entryOffset + 8,
			});
		}
		return entries;
	}

	function readEntryUnsigned(entry) {
		if (entry.type === 3) {
			return readUint16(entry.inlineOffset);
		}
		return entry.rawValueOffset;
	}

	function readEntryDataOffset(entry) {
		return entry.bytes <= 4 ? entry.inlineOffset : entry.rawValueOffset;
	}

	function readAscii(entry) {
		const start = readEntryDataOffset(entry);
		return buffer
			.toString("ascii", start, start + entry.valueCount)
			.replace(/\u0000+$/g, "")
			.trim();
	}

	function readGpsCoordinate(entries, valueTag, refTag, positiveRef) {
		const valueEntry = entries.get(valueTag);
		const refEntry = entries.get(refTag);
		if (!valueEntry || !refEntry) {
			return null;
		}
		const ref = readAscii(refEntry);
		const base = readEntryDataOffset(valueEntry);
		const degrees = readRational(base);
		const minutes = readRational(base + 8);
		const seconds = readRational(base + 16);
		const decimal = degrees + minutes / 60 + seconds / 3600;
		return ref === positiveRef ? decimal : -decimal;
	}

	const ifd0 = readIfdEntries(readUint32(4));
	const exifPointer = ifd0.get(0x8769);
	const gpsPointer = ifd0.get(0x8825);
	const exifIfd = exifPointer
		? readIfdEntries(readEntryUnsigned(exifPointer))
		: new Map();
	const gpsIfd = gpsPointer
		? readIfdEntries(readEntryUnsigned(gpsPointer))
		: new Map();
	const timestampEntry = exifIfd.get(0x9003) ?? exifIfd.get(0x0132);
	const captureTime = timestampEntry
		? normalizeExifTimestamp(readAscii(timestampEntry))
		: null;
	const lat = readGpsCoordinate(gpsIfd, 0x0002, 0x0001, "N");
	const lon = readGpsCoordinate(gpsIfd, 0x0004, 0x0003, "E");

	return { lat, lon, captureTime };
}

function applyHourCorrection(isoLikeValue, hourCorrection) {
	if (!isoLikeValue || hourCorrection === 0) {
		return isoLikeValue;
	}
	const parsed = Date.parse(isoLikeValue);
	if (Number.isNaN(parsed)) {
		return null;
	}
	return new Date(parsed + hourCorrection * 60 * 60 * 1000).toISOString();
}

function normalizeExifTimestamp(value) {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T");
	const iso = normalized.endsWith("Z") ? normalized : `${normalized}Z`;
	if (Number.isNaN(Date.parse(iso))) {
		return null;
	}
	return iso;
}

/**
 * Converts a local-time ISO string (no timezone marker) to UTC ISO,
 * treating the input as local time in the given IANA timezone.
 * DST-aware via one iteration.
 */
function interpretLocalAsTimezone(naiveIso, timezone) {
	const naiveMs = Date.parse(`${naiveIso}Z`);
	if (Number.isNaN(naiveMs)) {
		return null;
	}

	// Use formatToParts to reconstruct the local time as a naive UTC ms value,
	// avoiding locale-specific toLocaleString formats that vary across platforms.
	function localAsUtcMs(ms) {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		}).formatToParts(new Date(ms));
		const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
		return Date.parse(
			`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
		);
	}

	// offset = how far ahead local time is from UTC (positive for UTC+ zones)
	// actual UTC = naiveMs - offset
	const offset1 = localAsUtcMs(naiveMs) - naiveMs;
	const utcMs = naiveMs - offset1;
	// One more pass for DST boundary accuracy
	const offset2 = localAsUtcMs(utcMs) - utcMs;
	return new Date(naiveMs - offset2).toISOString();
}

/**
 * Adjusts a timestamp string to UTC using either hour correction or timezone
 * interpretation. When `isExif` is true the input is already a naive-UTC ISO
 * string (Z-appended local time) that needs the Z stripped before timezone
 * reinterpretation.
 */
function adjustTimestamp(value, timeOptions, isExif) {
	if (!value) {
		return null;
	}
	const { hourCorrection = 0, timezone = null } = timeOptions;
	if (timezone) {
		// Strip trailing Z so we have a plain local-time string to reinterpret
		const naive = isExif
			? value.replace(/Z$/, "")
			: /[Zz]$|[+-]\d{2}:\d{2}$/.test(value.trim())
				? null // already has timezone info — parse as-is
				: value.trim();
		if (naive === null) {
			// Value already carries timezone info; just normalise to UTC
			const parsed = Date.parse(value);
			if (Number.isNaN(parsed)) return null;
			return applyHourCorrection(
				new Date(parsed).toISOString(),
				hourCorrection,
			);
		}
		return applyHourCorrection(
			interpretLocalAsTimezone(naive, timezone),
			hourCorrection,
		);
	}
	// Legacy hour-correction path
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) {
		return null;
	}
	return applyHourCorrection(new Date(parsed).toISOString(), hourCorrection);
}

function hasGlob(pathValue) {
	return /[*?[]/.test(pathValue);
}

function resolveGlobBase(pathValue) {
	const parts = pathValue.split(/[\\/]+/);
	const baseParts = [];
	for (const part of parts) {
		if (/[*?[]/.test(part)) {
			break;
		}
		baseParts.push(part);
	}
	if (baseParts.length === 0) {
		return dirname(pathValue);
	}
	return baseParts.join("\\");
}

function globToRegex(pattern) {
	let regex = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		const next = pattern[index + 1];
		if (char === "*" && next === "*") {
			regex += ".*";
			index += 1;
			continue;
		}
		if (char === "*") {
			regex += "[^/]*";
			continue;
		}
		if (char === "?") {
			regex += ".";
			continue;
		}
		regex += escapeRegex(char);
	}
	regex += "$";
	return new RegExp(regex, "i");
}

function walkFiles(rootDir) {
	const results = [];
	const entries = readdirSync(rootDir, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = join(rootDir, entry.name);
		if (entry.isDirectory()) {
			results.push(...walkFiles(entryPath));
			continue;
		}
		if (entry.isFile()) {
			results.push(entryPath);
		}
	}
	return results;
}

function isImageFile(pathValue) {
	return IMAGE_EXTENSIONS.has(extname(pathValue).toLowerCase());
}

function copyDirectory(sourceDir, targetDir) {
	mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			copyDirectory(sourcePath, targetPath);
		} else if (entry.isFile()) {
			copyFileSync(sourcePath, targetPath);
		}
	}
}

function sanitizeFileStem(value) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "image"
	);
}

function normalizeLookupKey(value) {
	return toPosixPath(value).toLowerCase();
}

function toPosixPath(value) {
	return value.replace(/\\/g, "/");
}

function escapeRegex(value) {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function haversineKm(lat1, lon1, lat2, lon2) {
	const toRadians = (value) => (value * Math.PI) / 180;
	const dLat = toRadians(lat2 - lat1);
	const dLon = toRadians(lon2 - lon1);
	const sinLat = Math.sin(dLat / 2);
	const sinLon = Math.sin(dLon / 2);
	const a =
		sinLat * sinLat +
		Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * sinLon * sinLon;
	return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function latLonToUtm31(latitude, longitude) {
	const a = 6378137.0;
	const f = 1 / 298.257222101;
	const e2 = f * (2 - f);
	const ep2 = e2 / (1 - e2);
	const lat = (latitude * Math.PI) / 180;
	const lon = (longitude * Math.PI) / 180;
	const centralMeridian = ((31 - 1) * 6 - 180 + 3) * (Math.PI / 180);
	const k0 = 0.9996;

	const sinLat = Math.sin(lat);
	const cosLat = Math.cos(lat);
	const tanLat = Math.tan(lat);
	const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
	const t = tanLat * tanLat;
	const c = ep2 * cosLat * cosLat;
	const x = cosLat * (lon - centralMeridian);
	const m =
		a *
		((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * lat -
			((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) *
				Math.sin(2 * lat) +
			((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * lat) -
			((35 * e2 ** 3) / 3072) * Math.sin(6 * lat));

	return {
		easting:
			k0 *
				n *
				(x +
					((1 - t + c) * x ** 3) / 6 +
					((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * x ** 5) / 120) +
			500000,
		northing:
			k0 *
			(m +
				n *
					tanLat *
					(x ** 2 / 2 +
						((5 - t + 9 * c + 4 * c ** 2) * x ** 4) / 24 +
						((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * x ** 6) / 720)),
	};
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function lerp(start, end, t) {
	return start + (end - start) * t;
}

function distance2d(ax, az, bx, bz) {
	return Math.hypot(ax - bx, az - bz);
}

function average(values) {
	return (
		values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
	);
}
