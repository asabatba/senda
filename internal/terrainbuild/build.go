package terrainbuild

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func Run(options Options) (Summary, error) {
	var summary Summary

	stageTimings := make(map[string]int64)
	stageStart := func() func(string) {
		startedAt := time.Now()
		return func(name string) {
			stageTimings[name] = time.Since(startedAt).Milliseconds()
		}
	}

	options, err := resolveOptions(options)
	if err != nil {
		return summary, err
	}
	cache, err := newCacheManager(options)
	if err != nil {
		return summary, err
	}

	stopStage := stageStart()
	demPaths, err := discoverInputs(options.DataDir, resolveExplicitPaths(options.RepoRoot, options.DemFiles), demPattern, "DEM")
	if err != nil {
		return summary, err
	}
	orthophotoPaths, err := discoverInputs(options.DataDir, resolveExplicitPaths(options.RepoRoot, options.OrthophotoFiles), orthophotoPattern, "orthophoto")
	if err != nil {
		return summary, err
	}
	if err := validateOutputSafety(options); err != nil {
		return summary, err
	}
	stopStage("inputDiscovery")

	stopStage = stageStart()
	dems, mergedBounds, noDataValue, err := openDEMSources(demPaths, options.ExpectedDEMResolution)
	if err != nil {
		return summary, err
	}
	defer closeDEMReaders(dems)
	if noDataValue == nil {
		defaultNoData := -32767.0
		noDataValue = &defaultNoData
	}
	orthophotos, err := openOrthophotoSources(orthophotoPaths)
	if err != nil {
		return summary, err
	}
	defer closeOrthophotoReaders(orthophotos)
	stopStage("metadataProbe")

	sourceWidth := int(math.Round((mergedBounds.East - mergedBounds.West) / options.ExpectedDEMResolution))
	sourceHeight := int(math.Round((mergedBounds.North - mergedBounds.South) / options.ExpectedDEMResolution))
	meshTargetSize := computeTargetSize(sourceWidth, sourceHeight, options.MaxEdge)

	stopStage = stageStart()
	mergedRaster, validMask, err := buildDEMMosaic(dems, mergedBounds, float32(*noDataValue), meshTargetSize, cache, options)
	if err != nil {
		return summary, err
	}
	encodedHeights, elevationRange, err := encodeHeights(mergedRaster, validMask)
	if err != nil {
		return summary, err
	}
	stopStage("demMosaic")

	largestPreset := options.OrthophotoPresets[0]
	for _, preset := range options.OrthophotoPresets[1:] {
		if preset.MaxEdge > largestPreset.MaxEdge {
			largestPreset = preset
		}
	}
	largestTargetSize := computeTargetSize(sourceWidth, sourceHeight, largestPreset.MaxEdge)
	stopStage = stageStart()
	masterRGBA, masterAsset, err := buildOrthophotoMosaic(orthophotos, mergedBounds, largestTargetSize, cache, options)
	if err != nil {
		return summary, err
	}
	stopStage("orthophotoMaster")

	if err := os.MkdirAll(options.OutputDir, 0o755); err != nil {
		return summary, err
	}
	_ = os.Remove(filepath.Join(options.OutputDir, DefaultHeightAssetRaw))
	_ = os.Remove(filepath.Join(options.OutputDir, LegacyOrthophotoAsset))

	heightBytes, err := encodeUint16LittleEndian(encodedHeights)
	if err != nil {
		return summary, err
	}
	gzippedHeights, err := gzipBytes(heightBytes)
	if err != nil {
		return summary, err
	}
	if err := os.WriteFile(filepath.Join(options.OutputDir, DefaultHeightAsset), gzippedHeights, 0o644); err != nil {
		return summary, err
	}

	stopStage = stageStart()
	namedPlacesMetadata, namedPlacesBytes, err := buildNamedPlacesAsset(options, TerrainMetadata{
		Width:      meshTargetSize.Width,
		Height:     meshTargetSize.Height,
		Bounds:     mergedBounds,
		SizeMeters: SizeMeters{Width: mergedBounds.East - mergedBounds.West, Height: mergedBounds.North - mergedBounds.South},
	}, mergedRaster, validMask, cache)
	if err != nil {
		return summary, err
	}
	gzippedNamedPlaces, err := gzipBytes(namedPlacesBytes)
	if err != nil {
		return summary, err
	}
	if err := os.WriteFile(filepath.Join(options.OutputDir, DefaultNamedPlacesAsset), gzippedNamedPlaces, 0o644); err != nil {
		return summary, err
	}
	stopStage("namedPlaces")

	stopStage = stageStart()
	orthophotoMetadata := make(map[string]OrthophotoAsset, len(options.OrthophotoPresets))
	summaryPresets := make(map[string]OrthophotoReport, len(options.OrthophotoPresets))
	type presetResult struct {
		id     string
		asset  OrthophotoAsset
		report OrthophotoReport
		err    error
	}
	presetResults := make([]presetResult, len(options.OrthophotoPresets))
	var presetWG sync.WaitGroup
	for index, preset := range options.OrthophotoPresets {
		presetWG.Add(1)
		go func(index int, preset OrthophotoPreset) {
			defer presetWG.Done()
			targetSize := computeTargetSize(sourceWidth, sourceHeight, preset.MaxEdge)
			rgba := masterRGBA
			if targetSize.Width != masterAsset.Width || targetSize.Height != masterAsset.Height {
				rgba = resizeRGBABilinear(masterRGBA, masterAsset.Width, masterAsset.Height, targetSize.Width, targetSize.Height)
			}
			gzippedRGBA, err := gzipBytes(rgba)
			if err != nil {
				presetResults[index].err = err
				return
			}
			filename := orthophotoOutputFile(preset.ID)
			if err := os.WriteFile(filepath.Join(options.OutputDir, filename), gzippedRGBA, 0o644); err != nil {
				presetResults[index].err = err
				return
			}
			asset := OrthophotoAsset{
				URL:            filename,
				Format:         "rgba8",
				Compression:    "gzip",
				SourceFiles:    append([]string(nil), masterAsset.SourceFiles...),
				Width:          targetSize.Width,
				Height:         targetSize.Height,
				CoverageBounds: masterAsset.CoverageBounds,
			}
			presetResults[index] = presetResult{
				id:    preset.ID,
				asset: asset,
				report: OrthophotoReport{
					Width:          asset.Width,
					Height:         asset.Height,
					GzippedBytes:   len(gzippedRGBA),
					CoverageBounds: asset.CoverageBounds,
				},
			}
		}(index, preset)
	}
	presetWG.Wait()
	for _, result := range presetResults {
		if result.err != nil {
			return summary, result.err
		}
		orthophotoMetadata[result.id] = result.asset
		summaryPresets[result.id] = result.report
	}
	stopStage("orthophotoPresets")

	stopStage = stageStart()
	metadata := TerrainMetadata{
		SourceFiles: collectNames(dems),
		Width:       meshTargetSize.Width,
		Height:      meshTargetSize.Height,
		CRS: CRSMetadata{
			EPSG:  ExpectedEPSG,
			Kind:  "projected",
			Units: "meter",
		},
		Bounds: mergedBounds,
		SizeMeters: SizeMeters{
			Width:  mergedBounds.East - mergedBounds.West,
			Height: mergedBounds.North - mergedBounds.South,
		},
		ElevationRange: elevationRange,
		HeightAsset: HeightAsset{
			URL:         DefaultHeightAsset,
			Format:      "uint16",
			Compression: "gzip",
			NoDataCode:  0,
		},
		Orthophoto: OrthophotoMetadata{
			DefaultPreset: options.DefaultOrthophotoID,
			Presets:       orthophotoMetadata,
		},
		NamedPlaces:                 namedPlacesMetadata,
		DefaultVerticalExaggeration: DefaultVerticalExaggeration,
		Overlay: OverlayMetadata{
			URL: nil,
		},
	}

	metadataBytes, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return summary, err
	}
	metadataBytes = append(metadataBytes, '\n')
	if err := os.WriteFile(filepath.Join(options.OutputDir, DefaultMetadataFile), metadataBytes, 0o644); err != nil {
		return summary, err
	}
	stopStage("metadataWrite")

	relativeOutput, err := filepath.Rel(options.RepoRoot, options.OutputDir)
	if err != nil {
		relativeOutput = options.OutputDir
	}

	summary = Summary{
		Sources:            metadata.SourceFiles,
		MeshWidth:          metadata.Width,
		MeshHeight:         metadata.Height,
		OrthophotoPresets:  summaryPresets,
		NamedPlaceCount:    namedPlacesMetadata.FeatureCount,
		SizeMeters:         metadata.SizeMeters,
		ElevationRange:     metadata.ElevationRange,
		GzippedHeightBytes: len(gzippedHeights),
		StageMilliseconds:  stageTimings,
		CacheStats:         cache.summary(),
		OutputDir:          filepath.ToSlash(relativeOutput),
	}
	return summary, nil
}

func errNoDataMismatch(source *demSource, expected float64) error {
	return fmt.Errorf("%s uses nodata %v, expected %v", source.Name, *source.Metadata.NoData, expected)
}

func validateOutputSafety(options Options) error {
	if len(options.DemFiles) == 0 && len(options.OrthophotoFiles) == 0 {
		return nil
	}
	if !sameCleanPath(options.OutputDir, filepath.Join(options.RepoRoot, DefaultOutputDir)) {
		return nil
	}

	return fmt.Errorf(
		"subset input flags cannot write to %q; use a non-final --output-dir for smoke/test runs",
		filepath.ToSlash(DefaultOutputDir),
	)
}

func resolveExplicitPaths(repoRoot string, paths []string) []string {
	resolved := make([]string, 0, len(paths))
	for _, pathValue := range paths {
		resolved = append(resolved, resolvePath(repoRoot, pathValue))
	}
	return resolved
}

func validateDEM(source *demSource, expectedResolution float64) error {
	if source.Metadata.EPSG != ExpectedEPSG {
		return fmt.Errorf("%s must be EPSG:%d, received EPSG:%d", source.Name, ExpectedEPSG, source.Metadata.EPSG)
	}
	if math.Abs(source.Metadata.PixelWidth-expectedResolution) > 1e-6 || math.Abs(source.Metadata.PixelHeight-expectedResolution) > 1e-6 {
		return fmt.Errorf("%s must have %.0f m pixels, received %v x %v", source.Name, expectedResolution, source.Metadata.PixelWidth, source.Metadata.PixelHeight)
	}
	if source.Metadata.SamplesPerPixel != 1 {
		return fmt.Errorf("%s must be single-band, received %d samples", source.Name, source.Metadata.SamplesPerPixel)
	}
	return nil
}

func validateOrthophoto(source *orthophotoSource) error {
	if source.Metadata.EPSG != ExpectedEPSG {
		return fmt.Errorf("%s must be EPSG:%d, received EPSG:%d", source.Name, ExpectedEPSG, source.Metadata.EPSG)
	}
	if source.Metadata.SamplesPerPixel < 3 {
		return fmt.Errorf("%s must have at least 3 samples, received %d", source.Name, source.Metadata.SamplesPerPixel)
	}
	return nil
}

func closeDEMReaders(sources []*demSource) {
	for _, source := range sources {
		_ = source.Reader.Close()
	}
}

func closeOrthophotoReaders(sources []*orthophotoSource) {
	for _, source := range sources {
		_ = source.Reader.Close()
	}
}

func collectNames[T interface{ GetName() string }](sources []T) []string {
	names := make([]string, 0, len(sources))
	for _, source := range sources {
		names = append(names, source.GetName())
	}
	return names
}

func gzipBytes(data []byte) ([]byte, error) {
	var buffer bytes.Buffer
	writer, err := gzip.NewWriterLevel(&buffer, DefaultGzipLevel)
	if err != nil {
		return nil, err
	}
	if _, err := writer.Write(data); err != nil {
		_ = writer.Close()
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func encodeUint16LittleEndian(values []uint16) ([]byte, error) {
	buffer := make([]byte, len(values)*2)
	for index, value := range values {
		binary.LittleEndian.PutUint16(buffer[index*2:index*2+2], value)
	}
	return buffer, nil
}

func sameCleanPath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}
