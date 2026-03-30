package terrainbuild

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	namedPlacesMagic                    = "NPL1"
	namedPlacesFormat                   = "named-place-v1"
	namedPlaceMissingStringIndex uint32 = ^uint32(0)
)

var naturalNamedPlaceCategories = []string{
	"hydrography",
	"landform",
	"protectedSite",
}

var namedPlaceCategorySpecs = map[string]NamedPlaceCategoryInfo{
	"hydrography": {
		Label: "Hydrography",
		Color: "#6bd3ff",
	},
	"landform": {
		Label: "Landform",
		Color: "#f0d36f",
	},
	"protectedSite": {
		Label: "Protected site",
		Color: "#7fe08b",
	},
}

type namedPlaceCandidate struct {
	ID        string
	Name      string
	LocalType string
	Category  string
	Latitude  float64
	Longitude float64
}

func buildNamedPlacesAsset(
	options Options,
	metadata TerrainMetadata,
	mergedRaster []float32,
	validMask []uint8,
	cache *cacheManager,
) (*NamedPlacesAsset, []byte, error) {
	features, err := collectNamedPlaces(options, metadata, mergedRaster, validMask, cache)
	if err != nil {
		return nil, nil, err
	}

	categories := make(map[string]NamedPlaceCategoryInfo, len(namedPlaceCategorySpecs))
	for category, spec := range namedPlaceCategorySpecs {
		categories[category] = spec
	}
	for _, feature := range features {
		info := categories[feature.Category]
		info.Count++
		categories[feature.Category] = info
	}

	encoded, err := encodeNamedPlacesBinary(features)
	if err != nil {
		return nil, nil, err
	}

	return &NamedPlacesAsset{
		URL:          DefaultNamedPlacesAsset,
		Format:       namedPlacesFormat,
		Compression:  "gzip",
		FeatureCount: len(features),
		Categories:   categories,
	}, encoded, nil
}

func collectNamedPlaces(
	options Options,
	metadata TerrainMetadata,
	mergedRaster []float32,
	validMask []uint8,
	cache *cacheManager,
) ([]namedPlaceRecord, error) {
	gmlDir := filepath.Join(options.DataDir, DefaultGMLDir)
	paths, err := discoverNamedPlaceInputs(gmlDir, naturalNamedPlaceCategories)
	if err != nil {
		return nil, err
	}

	records := make([]namedPlaceRecord, 0, 1024)
	categoryIDs := make(map[string]uint8, len(naturalNamedPlaceCategories))
	for index, category := range naturalNamedPlaceCategories {
		categoryIDs[category] = uint8(index)
	}

	for _, path := range paths {
		candidates, err := loadCachedNamedPlaceCandidates(path, cache)
		if err != nil {
			return nil, err
		}
		for _, candidate := range candidates {
			projected := latLonToUTM31(candidate.Latitude, candidate.Longitude)
			normalizedX := (projected.Easting - metadata.Bounds.West) / (metadata.Bounds.East - metadata.Bounds.West)
			normalizedY := (metadata.Bounds.North - projected.Northing) / (metadata.Bounds.North - metadata.Bounds.South)
			if normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1 {
				continue
			}

			sampledHeight, ok := sampleMergedTerrainHeight(
				mergedRaster,
				validMask,
				metadata.Width,
				metadata.Height,
				normalizedX*float64(metadata.Width-1),
				normalizedY*float64(metadata.Height-1),
			)
			if !ok {
				continue
			}

			records = append(records, namedPlaceRecord{
				ID:            candidate.ID,
				Name:          candidate.Name,
				LocalType:     candidate.LocalType,
				Category:      candidate.Category,
				CategoryID:    categoryIDs[candidate.Category],
				Easting:       projected.Easting,
				Northing:      projected.Northing,
				TerrainHeight: sampledHeight,
				X: float32(normalizedX*metadata.SizeMeters.Width -
					metadata.SizeMeters.Width/2),
				Y: sampledHeight,
				Z: float32(normalizedY*metadata.SizeMeters.Height -
					metadata.SizeMeters.Height/2),
			})
		}
	}

	sort.Slice(records, func(i, j int) bool {
		if records[i].Category != records[j].Category {
			return records[i].Category < records[j].Category
		}
		if records[i].Name != records[j].Name {
			return records[i].Name < records[j].Name
		}
		return records[i].ID < records[j].ID
	})

	return records, nil
}

func loadCachedNamedPlaceCandidates(path string, cache *cacheManager) ([]namedPlaceCandidate, error) {
	fingerprint, err := fileFingerprint(path)
	if err != nil {
		return nil, err
	}
	key := cacheKey("named-places-gml-v1", fingerprint)

	var entry namedPlaceCandidatesCacheEntry
	if cache.loadGob("namedPlaces", key, &entry) {
		return entry.Candidates, nil
	}

	candidates, err := parseNamedPlacesGML(path)
	if err != nil {
		return nil, err
	}
	if err := cache.storeGob("namedPlaces", key, namedPlaceCandidatesCacheEntry{
		Candidates: candidates,
	}); err != nil {
		return nil, err
	}
	return candidates, nil
}

func discoverNamedPlaceInputs(gmlDir string, categories []string) ([]string, error) {
	entries, err := os.ReadDir(gmlDir)
	if err != nil {
		return nil, err
	}

	allowed := make(map[string]struct{}, len(categories))
	for _, category := range categories {
		allowed[strings.ToLower(category)] = struct{}{}
	}

	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".gml") {
			continue
		}
		category := categoryFromNamedPlaceFilename(name)
		if category == "" {
			continue
		}
		if _, ok := allowed[category]; !ok {
			continue
		}
		paths = append(paths, filepath.Join(gmlDir, name))
	}
	sort.Slice(paths, func(i, j int) bool {
		return filepath.Base(paths[i]) < filepath.Base(paths[j])
	})
	if len(paths) == 0 {
		return nil, fmt.Errorf("no named-place GML files were found in %q", gmlDir)
	}
	return paths, nil
}

func categoryFromNamedPlaceFilename(name string) string {
	trimmed := strings.TrimSuffix(strings.TrimPrefix(name, "gn_NamedPlace_"), filepath.Ext(name))
	if trimmed == name {
		return ""
	}
	for index, r := range trimmed {
		if r >= '0' && r <= '9' {
			return strings.ToLower(trimmed[:index])
		}
	}
	return strings.ToLower(trimmed)
}

func parseNamedPlacesGML(path string) ([]namedPlaceCandidate, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	decoder := xml.NewDecoder(file)
	records := make([]namedPlaceCandidate, 0, 256)
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}

		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "NamedPlace" {
			continue
		}
		record, ok, err := decodeNamedPlace(decoder, start)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if ok {
			records = append(records, record)
		}
	}

	return records, nil
}

func decodeNamedPlace(decoder *xml.Decoder, start xml.StartElement) (namedPlaceCandidate, bool, error) {
	record := namedPlaceCandidate{}
	hasGeometry := false
	for _, attr := range start.Attr {
		if attr.Name.Local == "id" {
			record.ID = attr.Value
			break
		}
	}

	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return record, false, io.ErrUnexpectedEOF
			}
			return record, false, err
		}

		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "geometry":
				lat, lon, ok, err := decodeNamedPlaceGeometry(decoder, value)
				if err != nil {
					return record, false, err
				}
				if ok {
					hasGeometry = true
					record.Latitude = lat
					record.Longitude = lon
				}
			case "name":
				text, err := decodeNamedPlaceName(decoder, value)
				if err != nil {
					return record, false, err
				}
				record.Name = text
			case "localType":
				text, err := decodeFirstNestedText(decoder, value)
				if err != nil {
					return record, false, err
				}
				record.LocalType = text
			case "type":
				record.Category = namedPlaceCategoryFromHref(value.Attr)
				if err := decoder.Skip(); err != nil {
					return record, false, err
				}
			default:
				if err := decoder.Skip(); err != nil {
					return record, false, err
				}
			}
		case xml.EndElement:
			if value.Name.Local != start.Name.Local {
				continue
			}
			if record.Name == "" || record.Category == "" || !hasGeometry {
				return record, false, nil
			}
			return record, true, nil
		}
	}
}

func decodeNamedPlaceGeometry(decoder *xml.Decoder, start xml.StartElement) (float64, float64, bool, error) {
	for {
		token, err := decoder.Token()
		if err != nil {
			return 0, 0, false, err
		}

		switch value := token.(type) {
		case xml.StartElement:
			if value.Name.Local == "pos" {
				text, err := decodeElementText(decoder, value)
				if err != nil {
					return 0, 0, false, err
				}
				parts := strings.Fields(text)
				if len(parts) != 2 {
					return 0, 0, false, nil
				}
				lat, err := parseFloat(parts[0])
				if err != nil {
					return 0, 0, false, err
				}
				lon, err := parseFloat(parts[1])
				if err != nil {
					return 0, 0, false, err
				}
				for {
					next, err := decoder.Token()
					if err != nil {
						return 0, 0, false, err
					}
					if end, ok := next.(xml.EndElement); ok && end.Name.Local == start.Name.Local {
						return lat, lon, true, nil
					}
				}
			}
			lat, lon, ok, err := decodeNamedPlaceGeometry(decoder, value)
			if err != nil {
				return 0, 0, false, err
			}
			if ok {
				return lat, lon, true, nil
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return 0, 0, false, nil
			}
		}
	}
}

func decodeNamedPlaceName(decoder *xml.Decoder, start xml.StartElement) (string, error) {
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", err
		}

		switch value := token.(type) {
		case xml.StartElement:
			if value.Name.Local == "text" {
				return decodeElementText(decoder, value)
			}
			text, err := decodeNamedPlaceName(decoder, value)
			if err != nil {
				return "", err
			}
			if text != "" {
				return text, nil
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return "", nil
			}
		}
	}
}

func decodeFirstNestedText(decoder *xml.Decoder, start xml.StartElement) (string, error) {
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", err
		}

		switch value := token.(type) {
		case xml.CharData:
			text := strings.TrimSpace(string(value))
			if text != "" {
				return text, nil
			}
		case xml.StartElement:
			text, err := decodeFirstNestedText(decoder, value)
			if err != nil {
				return "", err
			}
			if text != "" {
				return text, nil
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return "", nil
			}
		}
	}
}

func decodeElementText(decoder *xml.Decoder, start xml.StartElement) (string, error) {
	var builder strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", err
		}

		switch value := token.(type) {
		case xml.CharData:
			builder.Write([]byte(value))
		case xml.StartElement:
			if err := decoder.Skip(); err != nil {
				return "", err
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return strings.TrimSpace(builder.String()), nil
			}
		}
	}
}

func namedPlaceCategoryFromHref(attrs []xml.Attr) string {
	for _, attr := range attrs {
		if attr.Name.Local != "href" {
			continue
		}
		index := strings.LastIndex(attr.Value, "/")
		if index < 0 || index == len(attr.Value)-1 {
			return ""
		}
		return attr.Value[index+1:]
	}
	return ""
}

type utmPoint struct {
	Easting  float64
	Northing float64
}

func latLonToUTM31(latitude, longitude float64) utmPoint {
	const (
		grs80A               = 6378137.0
		grs80F               = 1 / 298.257222101
		utmK0                = 0.9996
		utm31CentralMeridian = (3 * math.Pi) / 180
	)

	e2 := grs80F * (2 - grs80F)
	ep2 := e2 / (1 - e2)
	lat := latitude * math.Pi / 180
	lon := longitude * math.Pi / 180

	sinLat := math.Sin(lat)
	cosLat := math.Cos(lat)
	tanLat := math.Tan(lat)
	n := grs80A / math.Sqrt(1-e2*sinLat*sinLat)
	t := tanLat * tanLat
	c := ep2 * cosLat * cosLat
	a := cosLat * (lon - utm31CentralMeridian)
	m := grs80A * ((1-e2/4-(3*e2*e2)/64-(5*e2*e2*e2)/256)*lat -
		((3*e2)/8+(3*e2*e2)/32+(45*e2*e2*e2)/1024)*math.Sin(2*lat) +
		((15*e2*e2)/256+(45*e2*e2*e2)/1024)*math.Sin(4*lat) -
		((35*e2*e2*e2)/3072)*math.Sin(6*lat))

	return utmPoint{
		Easting: utmK0*n*(a+((1-t+c)*math.Pow(a, 3))/6+((5-18*t+t*t+72*c-58*ep2)*math.Pow(a, 5))/120) + 500000,
		Northing: utmK0 * (m + n*tanLat*(a*a/2+
			((5-t+9*c+4*c*c)*math.Pow(a, 4))/24+
			((61-58*t+t*t+600*c-330*ep2)*math.Pow(a, 6))/720)),
	}
}

func sampleMergedTerrainHeight(
	heights []float32,
	validMask []uint8,
	width, height int,
	x, y float64,
) (float32, bool) {
	maxX := width - 1
	maxY := height - 1
	clampedX := clampFloat64(x, 0, float64(maxX))
	clampedY := clampFloat64(y, 0, float64(maxY))
	x0 := int(math.Floor(clampedX))
	x1 := minInt(maxX, int(math.Ceil(clampedX)))
	y0 := int(math.Floor(clampedY))
	y1 := minInt(maxY, int(math.Ceil(clampedY)))

	tx := float32(clampedX - float64(x0))
	ty := float32(clampedY - float64(y0))

	samples := []struct {
		value  float32
		valid  bool
		weight float32
	}{
		sampledTerrainHeight(heights, validMask, width, x0, y0, (1-tx)*(1-ty)),
		sampledTerrainHeight(heights, validMask, width, x1, y0, tx*(1-ty)),
		sampledTerrainHeight(heights, validMask, width, x0, y1, (1-tx)*ty),
		sampledTerrainHeight(heights, validMask, width, x1, y1, tx*ty),
	}

	var weighted float32
	var total float32
	for _, sample := range samples {
		if !sample.valid || sample.weight == 0 {
			continue
		}
		weighted += sample.value * sample.weight
		total += sample.weight
	}
	if total == 0 {
		return 0, false
	}
	return weighted / total, true
}

func sampledTerrainHeight(heights []float32, validMask []uint8, width, x, y int, weight float32) struct {
	value  float32
	valid  bool
	weight float32
} {
	index := y*width + x
	if index < 0 || index >= len(heights) || validMask[index] == 0 {
		return struct {
			value  float32
			valid  bool
			weight float32
		}{weight: weight}
	}
	return struct {
		value  float32
		valid  bool
		weight float32
	}{
		value:  heights[index],
		valid:  true,
		weight: weight,
	}
}

func encodeNamedPlacesBinary(features []namedPlaceRecord) ([]byte, error) {
	stringsByKey := make(map[string]uint32, len(features)*2)
	stringValues := make([]string, 0, len(features)*2)
	stringIndex := func(value string) uint32 {
		if value == "" {
			return namedPlaceMissingStringIndex
		}
		if index, ok := stringsByKey[value]; ok {
			return index
		}
		index := uint32(len(stringValues))
		stringsByKey[value] = index
		stringValues = append(stringValues, value)
		return index
	}

	nameIndexes := make([]uint32, len(features))
	localTypeIndexes := make([]uint32, len(features))
	for index, feature := range features {
		nameIndexes[index] = stringIndex(feature.Name)
		localTypeIndexes[index] = stringIndex(feature.LocalType)
	}

	var buffer bytes.Buffer
	buffer.WriteString(namedPlacesMagic)
	for _, value := range []uint32{1, uint32(len(features)), uint32(len(stringValues))} {
		if err := binary.Write(&buffer, binary.LittleEndian, value); err != nil {
			return nil, err
		}
	}

	for _, value := range stringValues {
		data := []byte(value)
		if err := binary.Write(&buffer, binary.LittleEndian, uint32(len(data))); err != nil {
			return nil, err
		}
		if _, err := buffer.Write(data); err != nil {
			return nil, err
		}
	}

	for index, feature := range features {
		for _, value := range []float32{feature.X, feature.Y, feature.Z} {
			if err := binary.Write(&buffer, binary.LittleEndian, value); err != nil {
				return nil, err
			}
		}
		if err := binary.Write(&buffer, binary.LittleEndian, nameIndexes[index]); err != nil {
			return nil, err
		}
		if err := binary.Write(&buffer, binary.LittleEndian, localTypeIndexes[index]); err != nil {
			return nil, err
		}
		if err := binary.Write(&buffer, binary.LittleEndian, feature.CategoryID); err != nil {
			return nil, err
		}
		if _, err := buffer.Write([]byte{0, 0, 0}); err != nil {
			return nil, err
		}
	}

	return buffer.Bytes(), nil
}

func parseFloat(value string) (float64, error) {
	return strconv.ParseFloat(strings.TrimSpace(value), 64)
}
