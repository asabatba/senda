import { gunzipSync } from "fflate";

export function resolveAssetUrl(assetPath: string, baseUrl = document.baseURI) {
	return new URL(assetPath, baseUrl).toString();
}

function toArrayBuffer(bytes: Uint8Array) {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
}

function isGzipPayload(bytes: Uint8Array) {
	return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function inflateBinaryAsset(
	compressedBytes: Uint8Array,
	expectedByteLength: number,
	label: string,
) {
	if (!isGzipPayload(compressedBytes)) {
		if (
			expectedByteLength <= 0 ||
			compressedBytes.byteLength === expectedByteLength
		) {
			return toArrayBuffer(compressedBytes);
		}

		throw new Error(
			`${label} is not gzip-encoded and has ${compressedBytes.byteLength} bytes, expected ${expectedByteLength}.`,
		);
	}

	if ("DecompressionStream" in globalThis) {
		try {
			const stream = new Blob([compressedBytes])
				.stream()
				.pipeThrough(new DecompressionStream("gzip"));
			return await new Response(stream).arrayBuffer();
		} catch {
			// Fall back to JS inflate for browsers/servers with inconsistent gzip handling.
		}
	}

	const decompressed = gunzipSync(compressedBytes);
	return toArrayBuffer(decompressed);
}
