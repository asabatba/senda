package terrainbuild

import (
	"math"
)

func clampInt(value, minValue, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func clampFloat64(value, minValue, maxValue float64) float64 {
	return math.Min(maxValue, math.Max(minValue, value))
}

func expandBounds(acc, next Bounds) Bounds {
	return Bounds{
		West:  math.Min(acc.West, next.West),
		South: math.Min(acc.South, next.South),
		East:  math.Max(acc.East, next.East),
		North: math.Max(acc.North, next.North),
	}
}

func intersectBounds(a, b Bounds) (Bounds, bool) {
	overlap := Bounds{
		West:  math.Max(a.West, b.West),
		South: math.Max(a.South, b.South),
		East:  math.Min(a.East, b.East),
		North: math.Min(a.North, b.North),
	}
	if overlap.East <= overlap.West || overlap.North <= overlap.South {
		return Bounds{}, false
	}
	return overlap, true
}

func computeTargetSize(sourceWidth, sourceHeight, maxEdge int) Size {
	if sourceWidth >= sourceHeight {
		return Size{
			Width:  maxEdge,
			Height: maxInt(2, int(math.Round(float64(sourceHeight)/float64(sourceWidth)*float64(maxEdge)))),
		}
	}
	return Size{
		Width:  maxInt(2, int(math.Round(float64(sourceWidth)/float64(sourceHeight)*float64(maxEdge)))),
		Height: maxEdge,
	}
}

func computeDestinationWindow(tileBounds, mergedBounds Bounds, targetSize Size) Window {
	mergedWidth := mergedBounds.East - mergedBounds.West
	mergedHeight := mergedBounds.North - mergedBounds.South

	colStart := maxInt(0, minInt(
		targetSize.Width-1,
		int(math.Floor(((tileBounds.West-mergedBounds.West)/mergedWidth)*float64(targetSize.Width))),
	))
	colEnd := maxInt(colStart+1, minInt(
		targetSize.Width,
		int(math.Ceil(((tileBounds.East-mergedBounds.West)/mergedWidth)*float64(targetSize.Width))),
	))
	rowStart := maxInt(0, minInt(
		targetSize.Height-1,
		int(math.Floor(((mergedBounds.North-tileBounds.North)/mergedHeight)*float64(targetSize.Height))),
	))
	rowEnd := maxInt(rowStart+1, minInt(
		targetSize.Height,
		int(math.Ceil(((mergedBounds.North-tileBounds.South)/mergedHeight)*float64(targetSize.Height))),
	))

	return Window{
		ColStart: colStart,
		ColEnd:   colEnd,
		RowStart: rowStart,
		RowEnd:   rowEnd,
		Width:    colEnd - colStart,
		Height:   rowEnd - rowStart,
	}
}

func computeSourceWindowForBounds(metadata rasterMetadata, bounds Bounds) SourceWindow {
	left := clampInt(
		int(math.Floor((bounds.West-metadata.Bounds.West)/metadata.PixelWidth)),
		0,
		metadata.Width-1,
	)
	right := clampInt(
		int(math.Ceil((bounds.East-metadata.Bounds.West)/metadata.PixelWidth)),
		left+1,
		metadata.Width,
	)
	top := clampInt(
		int(math.Floor((metadata.Bounds.North-bounds.North)/metadata.PixelHeight)),
		0,
		metadata.Height-1,
	)
	bottom := clampInt(
		int(math.Ceil((metadata.Bounds.North-bounds.South)/metadata.PixelHeight)),
		top+1,
		metadata.Height,
	)

	return SourceWindow{
		Left:   left,
		Top:    top,
		Right:  right,
		Bottom: bottom,
	}
}

func isNoData(value, noData float32) bool {
	return math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) || math.Abs(float64(value-noData)) < 1e-6
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
