package terrainbuild

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestSmokeSingleInputs(t *testing.T) {
	if os.Getenv("TERRAIN_SMOKE") != "1" {
		t.Skip("set TERRAIN_SMOKE=1 to run the GeoTIFF smoke test")
	}

	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	outputDir := filepath.Join(repoRoot, ".codex-tmp", "terrain-smoke-output")
	_ = os.RemoveAll(outputDir)
	t.Cleanup(func() { _ = os.RemoveAll(outputDir) })

	summary, err := Run(Options{
		RepoRoot:        repoRoot,
		DataDir:         "data",
		OutputDir:       outputDir,
		MaxEdge:         256,
		DemFiles:        []string{"data/MDT02-ETRS89-HU31-0178-2-COB2.tif"},
		OrthophotoFiles: []string{"data/PNOA_MA_OF_ETRS89_HU31_h25_0178_2.tif"},
		OrthophotoPresets: []OrthophotoPreset{
			{ID: "256", MaxEdge: 256},
			{ID: "512", MaxEdge: 512},
			{ID: "1024", MaxEdge: 1024},
		},
		DefaultOrthophotoID: "1024",
	})
	if err != nil {
		t.Fatal(err)
	}

	metadataBytes, err := os.ReadFile(filepath.Join(outputDir, DefaultMetadataFile))
	if err != nil {
		t.Fatal(err)
	}
	var metadata TerrainMetadata
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		t.Fatal(err)
	}

	heightBytes := readGzipBytes(t, filepath.Join(outputDir, DefaultHeightAsset))
	expectedHeightBytes := metadata.Width * metadata.Height * 2
	if len(heightBytes) != expectedHeightBytes {
		t.Fatalf("height asset bytes = %d, want %d", len(heightBytes), expectedHeightBytes)
	}

	for presetID, asset := range metadata.Orthophoto.Presets {
		rgbaBytes := readGzipBytes(t, filepath.Join(outputDir, asset.URL))
		expectedRGBABytes := asset.Width * asset.Height * 4
		if len(rgbaBytes) != expectedRGBABytes {
			t.Fatalf("%s rgba bytes = %d, want %d", presetID, len(rgbaBytes), expectedRGBABytes)
		}
	}

	if summary.MeshWidth != metadata.Width || summary.MeshHeight != metadata.Height {
		t.Fatalf("summary mismatch: %+v metadata=%dx%d", summary, metadata.Width, metadata.Height)
	}
}

func readGzipBytes(t *testing.T, path string) []byte {
	t.Helper()

	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
