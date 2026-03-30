package terrainbuild

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestSubsetFlagsCannotWriteToProductionOutput(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}

	_, err = Run(Options{
		RepoRoot:        repoRoot,
		DataDir:         "data",
		OutputDir:       "public/data",
		MaxEdge:         64,
		DemFiles:        []string{"data/MDT02-ETRS89-HU31-0178-2-COB2.tif"},
		OrthophotoFiles: []string{"data/PNOA_MA_OF_ETRS89_HU31_h25_0178_2.tif"},
	})
	if err == nil {
		t.Fatal("expected subset write to public/data to fail")
	}
}

func TestSubsetFlagsCanWriteToTempOutput(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}

	options, err := resolveOptions(Options{
		RepoRoot:        repoRoot,
		DataDir:         "data",
		OutputDir:       ".codex-tmp/terrain-smoke-output",
		DemFiles:        []string{"data/MDT02-ETRS89-HU31-0178-2-COB2.tif"},
		OrthophotoFiles: []string{"data/PNOA_MA_OF_ETRS89_HU31_h25_0178_2.tif"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := validateOutputSafety(options); err != nil {
		t.Fatalf("expected temp output to be allowed, got %v", err)
	}
}

func TestSmokeSingleInputs(t *testing.T) {
	if os.Getenv("TERRAIN_SMOKE") != "1" {
		t.Skip("set TERRAIN_SMOKE=1 to run the GeoTIFF smoke test")
	}

	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	outputDir := filepath.Join(repoRoot, ".codex-tmp", "terrain-smoke-output")
	if sameCleanPath(outputDir, filepath.Join(repoRoot, DefaultOutputDir)) {
		t.Fatal("smoke test must not target public/data")
	}
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

func TestPublicDataRepresentsFullDataset(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}

	metadataPath := filepath.Join(repoRoot, DefaultOutputDir, DefaultMetadataFile)
	metadataBytes, err := os.ReadFile(metadataPath)
	if err != nil {
		t.Fatal(err)
	}
	var metadata TerrainMetadata
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		t.Fatal(err)
	}

	dataDir := filepath.Join(repoRoot, DefaultDataDir)
	demPaths, err := discoverInputs(dataDir, nil, demPattern, "DEM")
	if err != nil {
		t.Fatal(err)
	}
	expectedDEMNames := baseNames(demPaths)
	if !equalStrings(metadata.SourceFiles, expectedDEMNames) {
		t.Fatalf("public/data DEM sources = %v, want %v", metadata.SourceFiles, expectedDEMNames)
	}

	orthophotoPaths, err := discoverInputs(dataDir, nil, orthophotoPattern, "orthophoto")
	if err != nil {
		t.Fatal(err)
	}
	expectedOrthophotoNames, err := overlappingOrthophotoNames(orthophotoPaths, metadata.Bounds)
	if err != nil {
		t.Fatal(err)
	}

	heightByteCount := gzipByteCount(t, filepath.Join(repoRoot, DefaultOutputDir, DefaultHeightAsset))
	expectedHeightBytes := int64(metadata.Width * metadata.Height * 2)
	if heightByteCount != expectedHeightBytes {
		t.Fatalf("public/data height bytes = %d, want %d", heightByteCount, expectedHeightBytes)
	}

	for presetID, asset := range metadata.Orthophoto.Presets {
		if !equalStrings(asset.SourceFiles, expectedOrthophotoNames) {
			t.Fatalf("%s sourceFiles = %v, want %v", presetID, asset.SourceFiles, expectedOrthophotoNames)
		}
		rgbaByteCount := gzipByteCount(t, filepath.Join(repoRoot, DefaultOutputDir, asset.URL))
		expectedRGBABytes := int64(asset.Width * asset.Height * 4)
		if rgbaByteCount != expectedRGBABytes {
			t.Fatalf("%s rgba bytes = %d, want %d", presetID, rgbaByteCount, expectedRGBABytes)
		}
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

func gzipByteCount(t *testing.T, path string) int64 {
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

	count, err := io.Copy(io.Discard, reader)
	if err != nil {
		t.Fatal(err)
	}
	return count
}

func overlappingOrthophotoNames(paths []string, bounds Bounds) ([]string, error) {
	names := make([]string, 0, len(paths))
	for _, path := range paths {
		source, err := openOrthophotoSource(path)
		if err != nil {
			return nil, err
		}
		if _, ok := intersectBounds(bounds, source.Metadata.Bounds); ok {
			names = append(names, source.Name)
		}
		_ = source.Reader.Close()
	}
	sort.Strings(names)
	return names, nil
}

func baseNames(paths []string) []string {
	names := make([]string, 0, len(paths))
	for _, path := range paths {
		names = append(names, filepath.Base(path))
	}
	sort.Strings(names)
	return names
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}

	leftCopy := append([]string(nil), left...)
	rightCopy := append([]string(nil), right...)
	sort.Strings(leftCopy)
	sort.Strings(rightCopy)
	for index := range leftCopy {
		if leftCopy[index] != rightCopy[index] {
			return false
		}
	}
	return true
}
