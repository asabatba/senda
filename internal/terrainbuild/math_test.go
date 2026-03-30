package terrainbuild

import "testing"

func TestComputeTargetSize(t *testing.T) {
	got := computeTargetSize(100, 50, 400)
	if got.Width != 400 || got.Height != 200 {
		t.Fatalf("computeTargetSize landscape = %+v", got)
	}

	got = computeTargetSize(50, 100, 400)
	if got.Width != 200 || got.Height != 400 {
		t.Fatalf("computeTargetSize portrait = %+v", got)
	}
}

func TestComputeDestinationWindow(t *testing.T) {
	window := computeDestinationWindow(
		Bounds{West: 10, South: 20, East: 30, North: 40},
		Bounds{West: 0, South: 0, East: 100, North: 100},
		Size{Width: 1000, Height: 1000},
	)

	if window.ColStart != 100 || window.ColEnd != 300 || window.RowStart != 600 || window.RowEnd != 800 {
		t.Fatalf("unexpected destination window: %+v", window)
	}
}

func TestComputeSourceWindowForBounds(t *testing.T) {
	window := computeSourceWindowForBounds(
		rasterMetadata{
			Width:       100,
			Height:      50,
			Bounds:      Bounds{West: 100, South: 150, East: 200, North: 200},
			PixelWidth:  1,
			PixelHeight: 1,
		},
		Bounds{West: 110.2, South: 160.1, East: 129.9, North: 180.3},
	)

	if window.Left != 10 || window.Top != 19 || window.Right != 30 || window.Bottom != 40 {
		t.Fatalf("unexpected source window: %+v", window)
	}
}

func TestIsNoData(t *testing.T) {
	if !isNoData(-32767, -32767) {
		t.Fatal("expected nodata exact match")
	}
	if !isNoData(-32767.0000004, -32767) {
		t.Fatal("expected nodata epsilon match")
	}
	if isNoData(10, -32767) {
		t.Fatal("did not expect valid data to be nodata")
	}
}

func TestEncodeHeights(t *testing.T) {
	encoded, elevationRange, err := encodeHeights(
		[]float32{100, 110, 0, 120},
		[]uint8{1, 1, 0, 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	if elevationRange.Min != 100 || elevationRange.Max != 120 {
		t.Fatalf("unexpected elevation range: %+v", elevationRange)
	}
	if encoded[0] != 1 || encoded[1] <= encoded[0] || encoded[2] != 0 || encoded[3] != 65535 {
		t.Fatalf("unexpected encoded heights: %v", encoded)
	}
}

func TestResizeRGBABilinear(t *testing.T) {
	source := []byte{
		0, 0, 0, 255,
		255, 0, 0, 255,
		0, 255, 0, 255,
		255, 255, 255, 255,
	}

	got := resizeRGBABilinear(source, 2, 2, 1, 1)
	if len(got) != 4 {
		t.Fatalf("unexpected result length %d", len(got))
	}
	if got[0] < 120 || got[0] > 136 || got[1] < 120 || got[1] > 136 || got[2] < 55 || got[2] > 72 || got[3] != 255 {
		t.Fatalf("unexpected bilinear result %v", got)
	}
}
