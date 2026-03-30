export function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

export function parseNoData(image) {
	const rawValue = image.getGDALNoData?.();
	if (rawValue === undefined || rawValue === null) {
		return -32767;
	}

	const parsed = Number.parseFloat(String(rawValue));
	return Number.isFinite(parsed) ? parsed : -32767;
}

export function assertProjectedCrs(image, label, expectedEpsg) {
	const geoKeys = image.getGeoKeys?.() ?? {};
	const epsg = Number(geoKeys.ProjectedCSTypeGeoKey);

	if (epsg !== expectedEpsg) {
		throw new Error(
			`${label} must be EPSG:${expectedEpsg}, received "${geoKeys.ProjectedCSTypeGeoKey ?? "unknown"}".`,
		);
	}
}

export function assertResolution(image, label, expectedResolution) {
	const [resolutionX, resolutionY] = image.getResolution();
	if (
		Math.abs(resolutionX) !== expectedResolution ||
		Math.abs(resolutionY) !== expectedResolution
	) {
		throw new Error(
			`${label} must have ${expectedResolution} m pixels, received ${resolutionX} x ${resolutionY}.`,
		);
	}
}

export function assertRgbOrthophoto(image, label) {
	const samplesPerPixel = image.getSamplesPerPixel();
	if (samplesPerPixel < 3) {
		throw new Error(
			`${label} must have at least 3 samples per pixel, received ${samplesPerPixel}.`,
		);
	}
}

export function computeBounds(image) {
	const bbox = image.getBoundingBox?.();
	if (!bbox || bbox.length !== 4) {
		throw new Error("GeoTIFF is missing a valid bounding box.");
	}

	return {
		west: bbox[0],
		south: bbox[1],
		east: bbox[2],
		north: bbox[3],
	};
}

export function expandBounds(accumulator, bounds) {
	return {
		west: Math.min(accumulator.west, bounds.west),
		south: Math.min(accumulator.south, bounds.south),
		east: Math.max(accumulator.east, bounds.east),
		north: Math.max(accumulator.north, bounds.north),
	};
}

export function intersectBounds(a, b) {
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

export function computeTargetSize(sourceWidth, sourceHeight, maxEdge) {
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

export function isNoData(value, noDataValue) {
	return (
		!Number.isFinite(value) ||
		Object.is(value, noDataValue) ||
		Math.abs(value - noDataValue) < 1e-6
	);
}

export function computeDestinationWindow(tileBounds, mergedBounds, targetSize) {
	const mergedWidth = mergedBounds.east - mergedBounds.west;
	const mergedHeight = mergedBounds.north - mergedBounds.south;

	const colStart = Math.max(
		0,
		Math.min(
			targetSize.width - 1,
			Math.floor(
				((tileBounds.west - mergedBounds.west) / mergedWidth) *
					targetSize.width,
			),
		),
	);
	const colEnd = Math.max(
		colStart + 1,
		Math.min(
			targetSize.width,
			Math.ceil(
				((tileBounds.east - mergedBounds.west) / mergedWidth) *
					targetSize.width,
			),
		),
	);
	const rowStart = Math.max(
		0,
		Math.min(
			targetSize.height - 1,
			Math.floor(
				((mergedBounds.north - tileBounds.north) / mergedHeight) *
					targetSize.height,
			),
		),
	);
	const rowEnd = Math.max(
		rowStart + 1,
		Math.min(
			targetSize.height,
			Math.ceil(
				((mergedBounds.north - tileBounds.south) / mergedHeight) *
					targetSize.height,
			),
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

export function computeSourceWindowForBounds(image, imageBounds, bounds) {
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
