package terrainbuild

import (
	"bytes"
	"compress/flate"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"io"
	"math"
	"os"
	"strconv"
	"strings"

	gdengeotiff "github.com/gden173/geotiff/geotiff"
	googletiff "github.com/google/tiff"
	_ "github.com/google/tiff/bigtiff"
	_ "github.com/google/tiff/geotiff"
)

const (
	tiffVersionClassic = 42
	tiffVersionBig     = 43

	compressionNone    = 1
	compressionJPEG    = 7
	compressionDeflate = 8

	photometricBlackIsZero = 1
	photometricYCbCr       = 6

	planarConfigChunky = 1

	sampleFormatFloat = 3

	projectedCSTypeGeoKey = 3072
)

type googleRaster struct {
	path               string
	file               *os.File
	tiff               googletiff.TIFF
	ifd                googletiff.IFD
	byteOrder          binary.ByteOrder
	metadata           rasterMetadata
	tileOffsets        []uint64
	tileByteCounts     []uint64
	jpegTables         []byte
	orthophotoRowCache map[int]map[int]*decodedTile
}

type decodedTile struct {
	width  int
	height int
	pixels []uint8
}

func openDemSource(path string) (*demSource, error) {
	if version, err := sniffTIFFVersion(path); err == nil && version == tiffVersionClassic {
		_ = probeWithGden(path)
	}

	raster, err := openGoogleRaster(path)
	if err != nil {
		return nil, err
	}

	return &demSource{
		Name:     filepathBase(path),
		Path:     path,
		Metadata: raster.metadata,
		Reader:   raster,
	}, nil
}

func openOrthophotoSource(path string) (*orthophotoSource, error) {
	raster, err := openGoogleRaster(path)
	if err != nil {
		return nil, err
	}

	return &orthophotoSource{
		Name:     filepathBase(path),
		Path:     path,
		Metadata: raster.metadata,
		Reader:   raster,
	}, nil
}

func openGoogleRaster(path string) (*googleRaster, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	tf, err := googletiff.Parse(googletiff.NewReadAtReadSeeker(file), nil, nil)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if len(tf.IFDs()) == 0 {
		_ = file.Close()
		return nil, fmt.Errorf("%s: missing TIFF IFD", path)
	}
	ifd := tf.IFDs()[0]
	order := fieldByteOrder(ifd.GetField(256))

	metadata, offsets, counts, jpegTables, err := parseRasterMetadata(ifd, order)
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("%s: %w", path, err)
	}

	return &googleRaster{
		path:               path,
		file:               file,
		tiff:               tf,
		ifd:                ifd,
		byteOrder:          order,
		metadata:           metadata,
		tileOffsets:        offsets,
		tileByteCounts:     counts,
		jpegTables:         jpegTables,
		orthophotoRowCache: make(map[int]map[int]*decodedTile),
	}, nil
}

func (r *googleRaster) Close() error {
	return r.file.Close()
}

func (r *googleRaster) ReadFullFloat32() ([]float32, error) {
	if r.metadata.Compression != compressionDeflate {
		return nil, fmt.Errorf("%s: unsupported DEM compression %d", r.path, r.metadata.Compression)
	}
	if r.metadata.SamplesPerPixel != 1 {
		return nil, fmt.Errorf("%s: DEM must be single-band, received %d samples", r.path, r.metadata.SamplesPerPixel)
	}
	if len(r.metadata.BitsPerSample) == 0 || r.metadata.BitsPerSample[0] != 32 {
		return nil, fmt.Errorf("%s: DEM must use 32-bit samples", r.path)
	}
	if r.metadata.SampleFormat != sampleFormatFloat {
		return nil, fmt.Errorf("%s: DEM must use float32 samples", r.path)
	}
	if r.metadata.PlanarConfig != planarConfigChunky {
		return nil, fmt.Errorf("%s: unsupported planar configuration %d", r.path, r.metadata.PlanarConfig)
	}

	full := make([]float32, r.metadata.Width*r.metadata.Height)
	tilesAcross := (r.metadata.Width + r.metadata.TileWidth - 1) / r.metadata.TileWidth
	tilesDown := (r.metadata.Height + r.metadata.TileHeight - 1) / r.metadata.TileHeight

	for tileY := range tilesDown {
		for tileX := range tilesAcross {
			index := tileY*tilesAcross + tileX
			tile, err := r.decodeDEMTile(index)
			if err != nil {
				return nil, err
			}

			srcWidth := minInt(r.metadata.TileWidth, r.metadata.Width-tileX*r.metadata.TileWidth)
			srcHeight := minInt(r.metadata.TileHeight, r.metadata.Height-tileY*r.metadata.TileHeight)
			for row := range srcHeight {
				sourceOffset := row * r.metadata.TileWidth
				destOffset := (tileY*r.metadata.TileHeight+row)*r.metadata.Width + tileX*r.metadata.TileWidth
				copy(full[destOffset:destOffset+srcWidth], tile[sourceOffset:sourceOffset+srcWidth])
			}
		}
	}

	return full, nil
}

func (r *googleRaster) ReadRGBWindowBilinear(window SourceWindow, targetWidth, targetHeight int) ([]uint8, error) {
	if r.metadata.Compression != compressionJPEG {
		return nil, fmt.Errorf("%s: unsupported orthophoto compression %d", r.path, r.metadata.Compression)
	}
	if r.metadata.SamplesPerPixel < 3 {
		return nil, fmt.Errorf("%s: orthophoto must have at least 3 samples", r.path)
	}
	if targetWidth < 1 || targetHeight < 1 {
		return nil, fmt.Errorf("%s: invalid target size %dx%d", r.path, targetWidth, targetHeight)
	}

	sourceWidth := window.Right - window.Left
	sourceHeight := window.Bottom - window.Top
	if sourceWidth < 1 || sourceHeight < 1 {
		return nil, fmt.Errorf("%s: invalid source window %+v", r.path, window)
	}

	x0 := make([]int, targetWidth)
	x1 := make([]int, targetWidth)
	xWeight := make([]float32, targetWidth)
	scaleX := float64(sourceWidth) / float64(targetWidth)
	for col := 0; col < targetWidth; col++ {
		sourceX := clampFloat64(
			(float64(col)+0.5)*scaleX-0.5+float64(window.Left),
			float64(window.Left),
			float64(window.Right-1),
		)
		left := int(math.Floor(sourceX))
		right := minInt(window.Right-1, left+1)
		x0[col] = left
		x1[col] = right
		xWeight[col] = float32(sourceX - float64(left))
	}

	rgba := make([]uint8, targetWidth*targetHeight*4)
	scaleY := float64(sourceHeight) / float64(targetHeight)
	for row := range targetHeight {
		sourceY := clampFloat64(
			(float64(row)+0.5)*scaleY-0.5+float64(window.Top),
			float64(window.Top),
			float64(window.Bottom-1),
		)
		top := int(math.Floor(sourceY))
		bottom := minInt(window.Bottom-1, top+1)
		yWeight := float32(sourceY - float64(top))
		r.prepareOrthophotoRows(top/r.metadata.TileHeight, bottom/r.metadata.TileHeight)

		rowOffset := row * targetWidth * 4
		for col := range targetWidth {
			topLeft, err := r.sampleOrthophotoRGB(x0[col], top)
			if err != nil {
				return nil, err
			}
			topRight, err := r.sampleOrthophotoRGB(x1[col], top)
			if err != nil {
				return nil, err
			}
			bottomLeft, err := r.sampleOrthophotoRGB(x0[col], bottom)
			if err != nil {
				return nil, err
			}
			bottomRight, err := r.sampleOrthophotoRGB(x1[col], bottom)
			if err != nil {
				return nil, err
			}

			destOffset := rowOffset + col*4
			for channel := 0; channel < 3; channel++ {
				topValue := float32(topLeft[channel]) + (float32(topRight[channel])-float32(topLeft[channel]))*xWeight[col]
				bottomValue := float32(bottomLeft[channel]) + (float32(bottomRight[channel])-float32(bottomLeft[channel]))*xWeight[col]
				rgba[destOffset+channel] = uint8(math.Round(float64(topValue + (bottomValue-topValue)*yWeight)))
			}
			rgba[destOffset+3] = 255
		}
	}

	return rgba, nil
}

func (r *googleRaster) prepareOrthophotoRows(rows ...int) {
	active := make(map[int]struct{}, len(rows))
	for _, row := range rows {
		active[row] = struct{}{}
		if _, ok := r.orthophotoRowCache[row]; !ok {
			r.orthophotoRowCache[row] = make(map[int]*decodedTile)
		}
	}
	for cachedRow := range r.orthophotoRowCache {
		if _, ok := active[cachedRow]; !ok {
			delete(r.orthophotoRowCache, cachedRow)
		}
	}
}

func (r *googleRaster) sampleOrthophotoRGB(x, y int) ([3]uint8, error) {
	tileX := x / r.metadata.TileWidth
	tileY := y / r.metadata.TileHeight
	rowCache, ok := r.orthophotoRowCache[tileY]
	if !ok {
		r.prepareOrthophotoRows(tileY)
		rowCache = r.orthophotoRowCache[tileY]
	}

	tile, ok := rowCache[tileX]
	if !ok {
		decoded, err := r.decodeOrthophotoTile(tileX, tileY)
		if err != nil {
			return [3]uint8{}, err
		}
		rowCache[tileX] = decoded
		tile = decoded
	}

	localX := x - tileX*r.metadata.TileWidth
	localY := y - tileY*r.metadata.TileHeight
	localX = clampInt(localX, 0, tile.width-1)
	localY = clampInt(localY, 0, tile.height-1)
	offset := (localY*tile.width + localX) * 4
	return [3]uint8{
		tile.pixels[offset],
		tile.pixels[offset+1],
		tile.pixels[offset+2],
	}, nil
}

func (r *googleRaster) decodeDEMTile(index int) ([]float32, error) {
	compressed, err := r.readTileBytes(index)
	if err != nil {
		return nil, err
	}
	raw, err := inflateDeflate(compressed)
	if err != nil {
		return nil, fmt.Errorf("%s: failed to inflate DEM tile %d: %w", r.path, index, err)
	}

	expectedBytes := r.metadata.TileWidth * r.metadata.TileHeight * 4
	if len(raw) < expectedBytes {
		return nil, fmt.Errorf("%s: DEM tile %d inflated to %d bytes, expected at least %d", r.path, index, len(raw), expectedBytes)
	}

	values := make([]float32, r.metadata.TileWidth*r.metadata.TileHeight)
	for i := range values {
		offset := i * 4
		bits := r.byteOrder.Uint32(raw[offset : offset+4])
		values[i] = math.Float32frombits(bits)
	}
	return values, nil
}

func (r *googleRaster) decodeOrthophotoTile(tileX, tileY int) (*decodedTile, error) {
	tilesAcross := (r.metadata.Width + r.metadata.TileWidth - 1) / r.metadata.TileWidth
	index := tileY*tilesAcross + tileX
	compressed, err := r.readTileBytes(index)
	if err != nil {
		return nil, err
	}

	stream := buildJPEGTileStream(r.jpegTables, compressed)
	img, err := jpeg.Decode(bytes.NewReader(stream))
	if err != nil {
		return nil, fmt.Errorf("%s: failed to decode JPEG tile %d,%d: %w", r.path, tileX, tileY, err)
	}

	bounds := img.Bounds()
	rgbaImage := image.NewRGBA(bounds)
	draw.Draw(rgbaImage, bounds, img, bounds.Min, draw.Src)
	return &decodedTile{
		width:  bounds.Dx(),
		height: bounds.Dy(),
		pixels: rgbaImage.Pix,
	}, nil
}

func (r *googleRaster) readTileBytes(index int) ([]byte, error) {
	if index < 0 || index >= len(r.tileOffsets) || index >= len(r.tileByteCounts) {
		return nil, fmt.Errorf("%s: tile index %d out of range", r.path, index)
	}
	buf := make([]byte, r.tileByteCounts[index])
	if _, err := r.file.ReadAt(buf, int64(r.tileOffsets[index])); err != nil {
		return nil, err
	}
	return buf, nil
}

func parseRasterMetadata(ifd googletiff.IFD, order binary.ByteOrder) (rasterMetadata, []uint64, []uint64, []byte, error) {
	var metadata rasterMetadata

	width, err := getFieldUint(ifd, 256)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	height, err := getFieldUint(ifd, 257)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	bitsPerSample, err := getFieldUintSlice(ifd, 258)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	compression, err := getFieldUint(ifd, 259)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	photometric, err := getFieldUint(ifd, 262)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	samplesPerPixel, err := getFieldUintDefault(ifd, 277, 1)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	planarConfig, err := getFieldUintDefault(ifd, 284, planarConfigChunky)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	tileWidth, err := getFieldUint(ifd, 322)
	if err != nil {
		return metadata, nil, nil, nil, fmt.Errorf("tiled TIFF required: %w", err)
	}
	tileHeight, err := getFieldUint(ifd, 323)
	if err != nil {
		return metadata, nil, nil, nil, fmt.Errorf("tiled TIFF required: %w", err)
	}
	tileOffsets, err := getFieldUintSlice(ifd, 324)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	tileByteCounts, err := getFieldUintSlice(ifd, 325)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	pixelScale, err := getFieldFloat64Slice(ifd, 33550)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	tiepoint, err := getFieldFloat64Slice(ifd, 33922)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	epsg, err := getProjectedEPSG(ifd)
	if err != nil {
		return metadata, nil, nil, nil, err
	}
	noData, err := getNoData(ifd)
	if err != nil {
		return metadata, nil, nil, nil, err
	}

	metadata.Width = int(width)
	metadata.Height = int(height)
	metadata.PixelWidth = pixelScale[0]
	metadata.PixelHeight = pixelScale[1]
	metadata.EPSG = epsg
	metadata.SamplesPerPixel = int(samplesPerPixel)
	metadata.Compression = int(compression)
	metadata.Photometric = int(photometric)
	metadata.PlanarConfig = int(planarConfig)
	metadata.BitsPerSample = make([]int, 0, len(bitsPerSample))
	for _, bitCount := range bitsPerSample {
		metadata.BitsPerSample = append(metadata.BitsPerSample, int(bitCount))
	}
	metadata.SampleFormat = 1
	if sampleFormat, err := getFieldUintDefault(ifd, 339, 1); err != nil {
		return metadata, nil, nil, nil, err
	} else {
		metadata.SampleFormat = int(sampleFormat)
	}
	metadata.NoData = noData
	metadata.TileWidth = int(tileWidth)
	metadata.TileHeight = int(tileHeight)
	metadata.Bounds = computeBoundsFromTiepoint(metadata.Width, metadata.Height, pixelScale, tiepoint)

	var jpegTables []byte
	if ifd.HasField(347) {
		jpegTables = append([]byte(nil), ifd.GetField(347).Value().Bytes()...)
	}

	_ = order
	return metadata, tileOffsets, tileByteCounts, jpegTables, nil
}

func computeBoundsFromTiepoint(width, height int, pixelScale, tiepoint []float64) Bounds {
	west := tiepoint[3] - tiepoint[0]*pixelScale[0]
	north := tiepoint[4] + tiepoint[1]*pixelScale[1]
	return Bounds{
		West:  west,
		South: north - float64(height)*pixelScale[1],
		East:  west + float64(width)*pixelScale[0],
		North: north,
	}
}

func sniffTIFFVersion(path string) (uint16, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	header := make([]byte, 4)
	if _, err := io.ReadFull(file, header); err != nil {
		return 0, err
	}

	switch string(header[:2]) {
	case "II":
		return binary.LittleEndian.Uint16(header[2:4]), nil
	case "MM":
		return binary.BigEndian.Uint16(header[2:4]), nil
	default:
		return 0, fmt.Errorf("%s: invalid TIFF byte order", path)
	}
}

func probeWithGden(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	gt, err := gdengeotiff.Read(file)
	if err != nil {
		return err
	}
	_, err = gt.Bounds()
	return err
}

func inflateDeflate(data []byte) ([]byte, error) {
	reader, err := zlib.NewReader(bytes.NewReader(data))
	if err != nil {
		reader = flate.NewReader(bytes.NewReader(data))
	} else {
		defer reader.Close()
	}

	if reader == nil {
		return nil, err
	}
	defer reader.Close()

	return io.ReadAll(reader)
}

func buildJPEGTileStream(tables, tile []byte) []byte {
	if len(tables) == 0 {
		return tile
	}

	stream := append([]byte(nil), tables...)
	if len(stream) >= 2 && stream[len(stream)-2] == 0xff && stream[len(stream)-1] == 0xd9 {
		stream = stream[:len(stream)-2]
	}
	if len(tile) >= 2 && tile[0] == 0xff && tile[1] == 0xd8 {
		tile = tile[2:]
	}
	return append(stream, tile...)
}

func fieldByteOrder(field googletiff.Field) binary.ByteOrder {
	return field.Value().Order()
}

func getFieldUint(ifd googletiff.IFD, tagID uint16) (uint64, error) {
	values, err := getFieldUintSlice(ifd, tagID)
	if err != nil {
		return 0, err
	}
	if len(values) == 0 {
		return 0, fmt.Errorf("missing tag %d value", tagID)
	}
	return values[0], nil
}

func getFieldUintDefault(ifd googletiff.IFD, tagID uint16, fallback uint64) (uint64, error) {
	if !ifd.HasField(tagID) {
		return fallback, nil
	}
	return getFieldUint(ifd, tagID)
}

func getFieldUintSlice(ifd googletiff.IFD, tagID uint16) ([]uint64, error) {
	if !ifd.HasField(tagID) {
		return nil, fmt.Errorf("missing tag %d", tagID)
	}
	field := ifd.GetField(tagID)
	return decodeUintSlice(field.Value().Bytes(), field.Value().Order(), field.Type().Size(), int(field.Count()))
}

func getFieldFloat64Slice(ifd googletiff.IFD, tagID uint16) ([]float64, error) {
	if !ifd.HasField(tagID) {
		return nil, fmt.Errorf("missing tag %d", tagID)
	}
	field := ifd.GetField(tagID)
	return decodeFloat64Slice(field.Value().Bytes(), field.Value().Order(), field.Type().Size(), int(field.Count()))
}

func getProjectedEPSG(ifd googletiff.IFD) (int, error) {
	values, err := getFieldUintSlice(ifd, 34735)
	if err != nil {
		return 0, err
	}
	if len(values) < 4 {
		return 0, fmt.Errorf("invalid GeoKeyDirectoryTag")
	}

	keyCount := int(values[3])
	for index := range keyCount {
		base := 4 + index*4
		if base+3 >= len(values) {
			break
		}
		keyID := values[base]
		location := values[base+1]
		count := values[base+2]
		valueOffset := values[base+3]
		if keyID != projectedCSTypeGeoKey {
			continue
		}
		if location != 0 || count != 1 {
			return 0, fmt.Errorf("unsupported ProjectedCSTypeGeoKey encoding")
		}
		return int(valueOffset), nil
	}
	return 0, fmt.Errorf("missing ProjectedCSTypeGeoKey")
}

func getNoData(ifd googletiff.IFD) (*float64, error) {
	if !ifd.HasField(42113) {
		return nil, nil
	}
	field := ifd.GetField(42113)
	raw := strings.TrimRight(string(field.Value().Bytes()), "\x00 ")
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func decodeUintSlice(data []byte, order binary.ByteOrder, size uint64, count int) ([]uint64, error) {
	values := make([]uint64, count)
	for index := range count {
		offset := index * int(size)
		switch size {
		case 1:
			values[index] = uint64(data[offset])
		case 2:
			values[index] = uint64(order.Uint16(data[offset : offset+2]))
		case 4:
			values[index] = uint64(order.Uint32(data[offset : offset+4]))
		case 8:
			values[index] = order.Uint64(data[offset : offset+8])
		default:
			return nil, fmt.Errorf("unsupported unsigned integer size %d", size)
		}
	}
	return values, nil
}

func decodeFloat64Slice(data []byte, order binary.ByteOrder, size uint64, count int) ([]float64, error) {
	values := make([]float64, count)
	for index := range count {
		offset := index * int(size)
		switch size {
		case 4:
			values[index] = float64(math.Float32frombits(order.Uint32(data[offset : offset+4])))
		case 8:
			values[index] = math.Float64frombits(order.Uint64(data[offset : offset+8]))
		default:
			return nil, fmt.Errorf("unsupported float size %d", size)
		}
	}
	return values, nil
}

func filepathBase(path string) string {
	return strings.TrimSpace(filepathBaseSlow(path))
}

func filepathBaseSlow(path string) string {
	lastSlash := strings.LastIndexAny(path, `/\`)
	if lastSlash == -1 {
		return path
	}
	return path[lastSlash+1:]
}
