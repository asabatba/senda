package terrainbuild

import "fmt"

func (s *orthophotoSource) GetName() string {
	return s.Name
}

func buildOrthophotoMosaic(sources []*orthophotoSource, mergedBounds Bounds, targetSize Size) ([]byte, OrthophotoAsset, error) {
	rgba := make([]byte, targetSize.Width*targetSize.Height*4)
	var coverageBounds Bounds
	var coverageSet bool
	sourceFiles := make([]string, 0, len(sources))

	for _, source := range sources {
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
		windowRGBA, err := source.Reader.ReadRGBWindowBilinear(sourceWindow, destinationWindow.Width, destinationWindow.Height)
		if err != nil {
			return nil, OrthophotoAsset{}, err
		}

		for row := 0; row < destinationWindow.Height; row++ {
			sourceOffset := row * destinationWindow.Width * 4
			destOffset := ((destinationWindow.RowStart+row)*targetSize.Width + destinationWindow.ColStart) * 4
			copy(rgba[destOffset:destOffset+destinationWindow.Width*4], windowRGBA[sourceOffset:sourceOffset+destinationWindow.Width*4])
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
