package terrainbuild

import (
	"fmt"
	"strconv"
	"sync"
)

func (s *orthophotoSource) GetName() string {
	return s.Name
}

func buildOrthophotoMosaic(
	sources []*orthophotoSource,
	mergedBounds Bounds,
	targetSize Size,
	cache *cacheManager,
	options Options,
) ([]byte, OrthophotoAsset, error) {
	rgba := make([]byte, targetSize.Width*targetSize.Height*4)
	var coverageBounds Bounds
	var coverageSet bool
	sourceFiles := make([]string, 0, len(sources))
	type contribution struct {
		index             int
		sourceName        string
		overlap           Bounds
		destinationWindow Window
		rgba              []byte
		err               error
	}
	contributions := make([]contribution, len(sources))
	var wg sync.WaitGroup

	for index, source := range sources {
		overlap, ok := intersectBounds(mergedBounds, source.Metadata.Bounds)
		if !ok {
			continue
		}
		sourceFiles = append(sourceFiles, source.Name)
		if coverageSet {
			coverageBounds = expandBounds(coverageBounds, overlap)
		} else {
			coverageBounds = overlap
			coverageSet = true
		}

		destinationWindow := computeDestinationWindow(overlap, mergedBounds, targetSize)
		sourceWindow := computeSourceWindowForBounds(source.Metadata, overlap)
		wg.Add(1)
		go func(index int, source *orthophotoSource, overlap Bounds, destinationWindow Window, sourceWindow SourceWindow) {
			defer wg.Done()
			windowRGBA, err := loadCachedOrthophotoWindow(source, overlap, sourceWindow, destinationWindow, cache, options)
			contributions[index] = contribution{
				index:             index,
				sourceName:        source.Name,
				overlap:           overlap,
				destinationWindow: destinationWindow,
				rgba:              windowRGBA,
				err:               err,
			}
		}(index, source, overlap, destinationWindow, sourceWindow)
	}
	wg.Wait()

	for _, item := range contributions {
		if item.err != nil {
			return nil, OrthophotoAsset{}, item.err
		}
		if len(item.rgba) == 0 {
			continue
		}
		for row := 0; row < item.destinationWindow.Height; row++ {
			sourceOffset := row * item.destinationWindow.Width * 4
			destOffset := ((item.destinationWindow.RowStart+row)*targetSize.Width + item.destinationWindow.ColStart) * 4
			copy(rgba[destOffset:destOffset+item.destinationWindow.Width*4], item.rgba[sourceOffset:sourceOffset+item.destinationWindow.Width*4])
		}
	}

	if !coverageSet {
		return nil, OrthophotoAsset{}, fmt.Errorf("failed to build orthophoto mosaic")
	}

	return rgba, OrthophotoAsset{
		Format:         "rgba8",
		Compression:    "gzip",
		SourceFiles:    sourceFiles,
		Width:          targetSize.Width,
		Height:         targetSize.Height,
		CoverageBounds: coverageBounds,
	}, nil
}

func loadCachedOrthophotoWindow(
	source *orthophotoSource,
	overlap Bounds,
	sourceWindow SourceWindow,
	destinationWindow Window,
	cache *cacheManager,
	options Options,
) ([]uint8, error) {
	fingerprint, err := fileFingerprint(source.Path)
	if err != nil {
		return nil, err
	}
	key := cacheKey(
		"orthophoto-window-v1",
		fingerprint,
		formatBounds(overlap),
		strconv.Itoa(sourceWindow.Left),
		strconv.Itoa(sourceWindow.Top),
		strconv.Itoa(sourceWindow.Right),
		strconv.Itoa(sourceWindow.Bottom),
		strconv.Itoa(destinationWindow.Width),
		strconv.Itoa(destinationWindow.Height),
		strconv.Itoa(options.MaxEdge),
	)

	var entry orthophotoWindowCacheEntry
	if cache.loadGob("orthophoto", key, &entry) {
		if entry.Width == destinationWindow.Width && entry.Height == destinationWindow.Height && len(entry.RGBA) == entry.Width*entry.Height*4 {
			return entry.RGBA, nil
		}
	}

	windowRGBA, err := source.Reader.ReadRGBWindowBilinear(sourceWindow, destinationWindow.Width, destinationWindow.Height)
	if err != nil {
		return nil, err
	}
	if err := cache.storeGob("orthophoto", key, orthophotoWindowCacheEntry{
		Width:  destinationWindow.Width,
		Height: destinationWindow.Height,
		RGBA:   windowRGBA,
	}); err != nil {
		return nil, err
	}
	return windowRGBA, nil
}

func formatBounds(bounds Bounds) string {
	return strconv.FormatFloat(bounds.West, 'f', 6, 64) + "|" +
		strconv.FormatFloat(bounds.South, 'f', 6, 64) + "|" +
		strconv.FormatFloat(bounds.East, 'f', 6, 64) + "|" +
		strconv.FormatFloat(bounds.North, 'f', 6, 64)
}

func resizeRGBABilinear(source []byte, sourceWidth, sourceHeight, targetWidth, targetHeight int) []byte {
	if sourceWidth == targetWidth && sourceHeight == targetHeight {
		copied := make([]byte, len(source))
		copy(copied, source)
		return copied
	}

	target := make([]byte, targetWidth*targetHeight*4)
	scaleX := float64(sourceWidth) / float64(targetWidth)
	scaleY := float64(sourceHeight) / float64(targetHeight)

	for targetRow := range targetHeight {
		sourceY := clampFloat64((float64(targetRow)+0.5)*scaleY-0.5, 0, float64(sourceHeight-1))
		y0 := maxInt(0, int(sourceY))
		y1 := minInt(sourceHeight-1, y0+1)
		yWeight := sourceY - float64(y0)

		for targetCol := range targetWidth {
			sourceX := clampFloat64((float64(targetCol)+0.5)*scaleX-0.5, 0, float64(sourceWidth-1))
			x0 := maxInt(0, int(sourceX))
			x1 := minInt(sourceWidth-1, x0+1)
			xWeight := sourceX - float64(x0)

			targetOffset := (targetRow*targetWidth + targetCol) * 4
			for channel := range 4 {
				topLeft := source[(y0*sourceWidth+x0)*4+channel]
				topRight := source[(y0*sourceWidth+x1)*4+channel]
				bottomLeft := source[(y1*sourceWidth+x0)*4+channel]
				bottomRight := source[(y1*sourceWidth+x1)*4+channel]

				top := float64(topLeft) + (float64(topRight)-float64(topLeft))*xWeight
				bottom := float64(bottomLeft) + (float64(bottomRight)-float64(bottomLeft))*xWeight
				target[targetOffset+channel] = uint8(roundTo(top+(bottom-top)*yWeight, 0))
			}
		}
	}

	return target
}
