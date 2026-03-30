export const TRACK_COLORS = [
	"#ff8d5d",
	"#7ee081",
	"#57b8ff",
	"#ffd84d",
	"#fb83c8",
	"#c39bff",
];

export const TRACK_SURFACE_OFFSET = 14;

export const KEYBOARD_MOVE_CODES = new Set([
	"KeyW",
	"KeyA",
	"KeyS",
	"KeyD",
	"KeyQ",
	"KeyE",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"PageUp",
	"PageDown",
	"ShiftLeft",
	"ShiftRight",
]);

export const GRS80_A = 6378137.0;
export const GRS80_F = 1 / 298.257222101;
export const UTM_K0 = 0.9996;
export const UTM31_CENTRAL_MERIDIAN =
	((31 - 1) * 6 - 180 + 3) * (Math.PI / 180);
