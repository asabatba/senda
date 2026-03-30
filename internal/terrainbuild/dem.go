package terrainbuild

import (
	"fmt"
	"math"
	"strconv"
)

func (s *demSource) GetName() string {
	return s.Name
}

func buildDEMMosaic(
	sources []*demSource,
	mergedBounds Bounds,
	noDataValue float32,
	targetSize Size,
	cache *cacheManager,
	options Options,
) ([]float32, []uint8, error) {
	merged := make([]float32, targetSize.Width*targetSize.Height)
	validMask := make([]uint8, targetSize.Width*targetSize.Height)

	for _, source := range sources {
		window := computeDestinationWindow(source.Metadata.Bounds, mergedBounds, targetSize)
		raster, err := loadCachedDEMRaster(source, cache, options)
		if err != nil {
			return nil, nil, err
		}
		xLookup := nearestLookup(source.Metadata.Width, window.Width)
		yLookup := nearestLookup(source.Metadata.Height, window.Height)

		for row := 0; row < window.Height; row++ {
			sourceOffset := yLookup[row] * source.Metadata.Width
			destOffset := (window.RowStart+row)*targetSize.Width + window.ColStart
			for col := 0; col < window.Width; col++ {
				value := raster[sourceOffset+xLookup[col]]
				if isNoData(value, noDataValue) {
					continue
				}
				merged[destOffset+col] = value
				validMask[destOffset+col] = 1
			}
		}
	}

	return merged, validMask, nil
}

func loadCachedDEMRaster(source *demSource, cache *cacheManager, options Options) ([]float32, error) {
	fingerprint, err := fileFingerprint(source.Path)
	if err != nil {
		return nil, err
	}
	key := cacheKey(
		"dem-raster-v1",
		fingerprint,
		strconv.Itoa(source.Metadata.Width),
		strconv.Itoa(source.Metadata.Height),
		strconv.FormatFloat(options.ExpectedDEMResolution, 'f', 6, 64),
	)

	var entry demRasterCacheEntry
	if cache.loadGob("dem", key, &entry) {
		if entry.Width == source.Metadata.Width && entry.Height == source.Metadata.Height && len(entry.Raster) == entry.Width*entry.Height {
			return entry.Raster, nil
		}
	}

	raster, err := source.Reader.ReadFullFloat32()
	if err != nil {
		return nil, err
	}
	if err := cache.storeGob("dem", key, demRasterCacheEntry{
		Width:  source.Metadata.Width,
		Height: source.Metadata.Height,
		Raster: raster,
	}); err != nil {
		return nil, err
	}
	return raster, nil
}

func encodeHeights(mergedRaster []float32, validMask []uint8) ([]uint16, ElevationRange, error) {
	minElevation := float32(math.Inf(1))
	maxElevation := float32(math.Inf(-1))
	for index, value := range mergedRaster {
		if validMask[index] == 0 {
			continue
		}
		if value < minElevation {
			minElevation = value
		}
		if value > maxElevation {
			maxElevation = value
		}
	}

	if !isFiniteFloat32(minElevation) || !isFiniteFloat32(maxElevation) {
		return nil, ElevationRange{}, fmt.Errorf("the merged DEM mosaic does not contain any valid elevation values")
	}

	span := maxFloat32(maxElevation-minElevation, 1e-6)
	encoded := make([]uint16, len(mergedRaster))
	for index, value := range mergedRaster {
		if validMask[index] == 0 {
			encoded[index] = 0
			continue
		}
		normalized := (value - minElevation) / span
		code := math.Round(float64(normalized*65534 + 1))
		if code < 1 {
			code = 1
		}
		if code > 65535 {
			code = 65535
		}
		encoded[index] = uint16(code)
	}

	return encoded, ElevationRange{
		Min: roundTo(float64(minElevation), 3),
		Max: roundTo(float64(maxElevation), 3),
	}, nil
}

func nearestLookup(sourceSize, targetSize int) []int {
	lookup := make([]int, targetSize)
	scale := float64(sourceSize) / float64(targetSize)
	for index := range targetSize {
		source := clampFloat64((float64(index)+0.5)*scale-0.5, 0, float64(sourceSize-1))
		lookup[index] = clampInt(int(math.Round(source)), 0, sourceSize-1)
	}
	return lookup
}

func isFiniteFloat32(value float32) bool {
	return !math.IsNaN(float64(value)) && !math.IsInf(float64(value), 0)
}

func maxFloat32(a, b float32) float32 {
	if a > b {
		return a
	}
	return b
}

func roundTo(value float64, decimals int) float64 {
	scale := math.Pow10(decimals)
	return math.Round(value*scale) / scale
}
