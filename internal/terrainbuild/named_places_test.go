package terrainbuild

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"io"
	"testing"
)

func TestDecodeNamedPlace(t *testing.T) {
	decoder := xml.NewDecoder(bytes.NewBufferString(`
<gn:NamedPlace xmlns:gn="http://inspire.ec.europa.eu/schemas/gn/4.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xlink="http://www.w3.org/1999/xlink" gml:id="ES.IGN.NGBE.1815377">
  <gn:geometry>
    <gml:Point>
      <gml:pos>42.516480 0.959290</gml:pos>
    </gml:Point>
  </gn:geometry>
  <gn:localType>Masa de agua</gn:localType>
  <gn:name>
    <gn:GeographicalName>
      <gn:spelling>
        <gn:SpellingOfName>
          <gn:text>Estany de Reguera</gn:text>
        </gn:SpellingOfName>
      </gn:spelling>
    </gn:GeographicalName>
  </gn:name>
  <gn:type xlink:href="https://inspire.ec.europa.eu/codelist/NamedPlaceTypeValue/hydrography"></gn:type>
</gn:NamedPlace>`))

	for {
		token, err := decoder.Token()
		if err != nil {
			t.Fatal(err)
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "NamedPlace" {
			continue
		}
		record, ok, err := decodeNamedPlace(decoder, start)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatal("expected named place")
		}
		if record.ID != "ES.IGN.NGBE.1815377" || record.Name != "Estany de Reguera" || record.LocalType != "Masa de agua" || record.Category != "hydrography" {
			t.Fatalf("unexpected record: %+v", record)
		}
		if record.Latitude != 42.51648 || record.Longitude != 0.95929 {
			t.Fatalf("unexpected coordinates: %+v", record)
		}
		return
	}
}

func TestLatLonToUTM31(t *testing.T) {
	projected := latLonToUTM31(42.516480, 0.959290)
	if projected.Easting < 332363 || projected.Easting > 332365 {
		t.Fatalf("unexpected easting %.6f", projected.Easting)
	}
	if projected.Northing < 4709140 || projected.Northing > 4709142 {
		t.Fatalf("unexpected northing %.6f", projected.Northing)
	}
}

func TestSampleMergedTerrainHeight(t *testing.T) {
	heights := []float32{
		100, 110,
		120, 130,
	}
	validMask := []uint8{
		1, 1,
		1, 0,
	}

	height, ok := sampleMergedTerrainHeight(heights, validMask, 2, 2, 0.25, 0.25)
	if !ok {
		t.Fatal("expected valid sample")
	}
	if height < 106 || height > 110 {
		t.Fatalf("unexpected interpolated height %f", height)
	}

	_, ok = sampleMergedTerrainHeight(
		[]float32{0, 0, 0, 0},
		[]uint8{0, 0, 0, 0},
		2,
		2,
		0.5,
		0.5,
	)
	if ok {
		t.Fatal("expected nodata sample to fail")
	}
}

func TestEncodeNamedPlacesBinary(t *testing.T) {
	encoded, err := encodeNamedPlacesBinary([]namedPlaceRecord{
		{
			Name:       "Pic de Test",
			LocalType:  "Cim",
			CategoryID: 1,
			X:          10,
			Y:          20,
			Z:          30,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	reader := bytes.NewReader(encoded)
	magic := make([]byte, 4)
	if _, err := io.ReadFull(reader, magic); err != nil {
		t.Fatal(err)
	}
	if string(magic) != namedPlacesMagic {
		t.Fatalf("unexpected magic %q", string(magic))
	}

	var version uint32
	var featureCount uint32
	var stringCount uint32
	for _, value := range []*uint32{&version, &featureCount, &stringCount} {
		if err := binary.Read(reader, binary.LittleEndian, value); err != nil {
			t.Fatal(err)
		}
	}
	if version != 1 || featureCount != 1 || stringCount != 2 {
		t.Fatalf("unexpected header version=%d featureCount=%d stringCount=%d", version, featureCount, stringCount)
	}

	var firstLen uint32
	if err := binary.Read(reader, binary.LittleEndian, &firstLen); err != nil {
		t.Fatal(err)
	}
	if firstLen != uint32(len("Pic de Test")) {
		t.Fatalf("unexpected first string length %d", firstLen)
	}
}
