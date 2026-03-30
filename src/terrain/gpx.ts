import type { TrackPoint, TrackSegment } from "./types";

function getDirectChildrenByTag(parent: Element, tagName: string) {
	const normalizedTagName = tagName.toLowerCase();
	return Array.from(parent.children).filter(
		(child) => child.tagName.toLowerCase() === normalizedTagName,
	);
}

function parseTrackPoint(element: Element): TrackPoint | null {
	const lat = Number.parseFloat(element.getAttribute("lat") ?? "");
	const lon = Number.parseFloat(element.getAttribute("lon") ?? "");

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return null;
	}

	const eleElement = getDirectChildrenByTag(element, "ele")[0];
	const ele = eleElement
		? Number.parseFloat(eleElement.textContent ?? "")
		: Number.NaN;

	return {
		lat,
		lon,
		ele: Number.isFinite(ele) ? ele : null,
	};
}

export function parseGpxSegments(xmlText: string) {
	const documentParser = new DOMParser();
	const xmlDocument = documentParser.parseFromString(
		xmlText,
		"application/xml",
	);
	if (xmlDocument.querySelector("parsererror")) {
		throw new Error("The GPX file is not valid XML.");
	}

	const segments: TrackSegment[] = [];

	for (const trkseg of Array.from(xmlDocument.getElementsByTagName("trkseg"))) {
		const points = getDirectChildrenByTag(trkseg, "trkpt")
			.map((pointElement) => parseTrackPoint(pointElement))
			.filter((point): point is TrackPoint => point !== null);
		if (points.length > 0) {
			segments.push({ points });
		}
	}

	for (const route of Array.from(xmlDocument.getElementsByTagName("rte"))) {
		const points = getDirectChildrenByTag(route, "rtept")
			.map((pointElement) => parseTrackPoint(pointElement))
			.filter((point): point is TrackPoint => point !== null);
		if (points.length > 0) {
			segments.push({ points });
		}
	}

	if (segments.length === 0) {
		throw new Error("The GPX file does not contain any track or route points.");
	}

	return segments;
}
