import { GRS80_A, GRS80_F, UTM_K0, UTM31_CENTRAL_MERIDIAN } from "./constants";

export function latLonToUtm31(latitude: number, longitude: number) {
	const e2 = GRS80_F * (2 - GRS80_F);
	const ep2 = e2 / (1 - e2);
	const lat = (latitude * Math.PI) / 180;
	const lon = (longitude * Math.PI) / 180;

	const sinLat = Math.sin(lat);
	const cosLat = Math.cos(lat);
	const tanLat = Math.tan(lat);
	const n = GRS80_A / Math.sqrt(1 - e2 * sinLat * sinLat);
	const t = tanLat * tanLat;
	const c = ep2 * cosLat * cosLat;
	const a = cosLat * (lon - UTM31_CENTRAL_MERIDIAN);
	const m =
		GRS80_A *
		((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * lat -
			((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) *
				Math.sin(2 * lat) +
			((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * lat) -
			((35 * e2 ** 3) / 3072) * Math.sin(6 * lat));

	const easting =
		UTM_K0 *
			n *
			(a +
				((1 - t + c) * a ** 3) / 6 +
				((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * a ** 5) / 120) +
		500000;

	const northing =
		UTM_K0 *
		(m +
			n *
				tanLat *
				(a ** 2 / 2 +
					((5 - t + 9 * c + 4 * c ** 2) * a ** 4) / 24 +
					((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * a ** 6) / 720));

	return { easting, northing };
}
