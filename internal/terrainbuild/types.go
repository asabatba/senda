package terrainbuild

type Bounds struct {
	West  float64 `json:"west"`
	South float64 `json:"south"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

type Size struct {
	Width  int
	Height int
}

type Window struct {
	ColStart int
	ColEnd   int
	RowStart int
	RowEnd   int
	Width    int
	Height   int
}

type SourceWindow struct {
	Left   int
	Top    int
	Right  int
	Bottom int
}

type OrthophotoPreset struct {
	ID      string
	MaxEdge int
}

type Options struct {
	RepoRoot              string
	DataDir               string
	OutputDir             string
	CacheDir              string
	NoCache               bool
	MaxEdge               int
	DemFiles              []string
	OrthophotoFiles       []string
	OrthophotoPresets     []OrthophotoPreset
	DefaultOrthophotoID   string
	ExpectedDEMResolution float64
}

type Summary struct {
	Sources             []string                    `json:"sources"`
	MeshWidth           int                         `json:"meshWidth"`
	MeshHeight          int                         `json:"meshHeight"`
	OrthophotoPresets   map[string]OrthophotoReport `json:"orthophotoPresets"`
	NamedPlaceCount     int                         `json:"namedPlaceCount"`
	SizeMeters          SizeMeters                  `json:"sizeMeters"`
	ElevationRange      ElevationRange              `json:"elevationRange"`
	GzippedHeightBytes  int                         `json:"gzippedHeightBytes"`
	StageMilliseconds   map[string]int64            `json:"stageMilliseconds"`
	CacheStats          map[string]CacheStat        `json:"cacheStats"`
	ElapsedMilliseconds int64                       `json:"elapsedMilliseconds"`
	Elapsed             string                      `json:"elapsed"`
	OutputDir           string                      `json:"outputDir"`
}

type CacheStat struct {
	Hits   int `json:"hits"`
	Misses int `json:"misses"`
}

type OrthophotoReport struct {
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	GzippedBytes   int    `json:"gzippedBytes"`
	CoverageBounds Bounds `json:"coverageBounds"`
}

type SizeMeters struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type ElevationRange struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

type HeightAsset struct {
	URL         string `json:"url"`
	Format      string `json:"format"`
	Compression string `json:"compression"`
	NoDataCode  int    `json:"noDataCode"`
}

type OrthophotoAsset struct {
	URL            string   `json:"url"`
	Format         string   `json:"format"`
	Compression    string   `json:"compression"`
	SourceFiles    []string `json:"sourceFiles"`
	Width          int      `json:"width"`
	Height         int      `json:"height"`
	CoverageBounds Bounds   `json:"coverageBounds"`
}

type TerrainMetadata struct {
	SourceFiles                 []string           `json:"sourceFiles"`
	Width                       int                `json:"width"`
	Height                      int                `json:"height"`
	CRS                         CRSMetadata        `json:"crs"`
	Bounds                      Bounds             `json:"bounds"`
	SizeMeters                  SizeMeters         `json:"sizeMeters"`
	ElevationRange              ElevationRange     `json:"elevationRange"`
	HeightAsset                 HeightAsset        `json:"heightAsset"`
	Orthophoto                  OrthophotoMetadata `json:"orthophoto"`
	NamedPlaces                 *NamedPlacesAsset  `json:"namedPlaces"`
	DefaultVerticalExaggeration float64            `json:"defaultVerticalExaggeration"`
	Overlay                     OverlayMetadata    `json:"overlay"`
}

type CRSMetadata struct {
	EPSG  int    `json:"epsg"`
	Kind  string `json:"kind"`
	Units string `json:"units"`
}

type OrthophotoMetadata struct {
	DefaultPreset string                     `json:"defaultPreset"`
	Presets       map[string]OrthophotoAsset `json:"presets"`
}

type OverlayMetadata struct {
	URL *string `json:"url"`
}

type NamedPlacesAsset struct {
	URL          string                            `json:"url"`
	Format       string                            `json:"format"`
	Compression  string                            `json:"compression"`
	FeatureCount int                               `json:"featureCount"`
	Categories   map[string]NamedPlaceCategoryInfo `json:"categories"`
}

type NamedPlaceCategoryInfo struct {
	Label string `json:"label"`
	Count int    `json:"count"`
	Color string `json:"color"`
}

type namedPlaceRecord struct {
	ID            string
	Name          string
	LocalType     string
	Category      string
	CategoryID    uint8
	Easting       float64
	Northing      float64
	TerrainHeight float32
	X             float32
	Y             float32
	Z             float32
}

type orthophotoWindowCacheEntry struct {
	Width  int
	Height int
	RGBA   []byte
}

type rasterMetadata struct {
	Width           int
	Height          int
	Bounds          Bounds
	PixelWidth      float64
	PixelHeight     float64
	EPSG            int
	SamplesPerPixel int
	Compression     int
	Photometric     int
	PlanarConfig    int
	BitsPerSample   []int
	SampleFormat    int
	NoData          *float64
	TileWidth       int
	TileHeight      int
}

type demSource struct {
	Name     string
	Path     string
	Metadata rasterMetadata
	Reader   demReader
}

type orthophotoSource struct {
	Name     string
	Path     string
	Metadata rasterMetadata
	Reader   orthophotoReader
}

type demReader interface {
	ReadFullFloat32() ([]float32, error)
	Close() error
}

type orthophotoReader interface {
	ReadRGBWindowBilinear(window SourceWindow, targetWidth, targetHeight int) ([]uint8, error)
	Close() error
}
