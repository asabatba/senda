package terrainbuild

import (
	"fmt"
	"path/filepath"
	"strconv"
)

const (
	DefaultDataDir              = "data"
	DefaultOutputDir            = "public/data"
	DefaultHeightAsset          = "terrain-height.u16.bin.gz"
	DefaultHeightAssetRaw       = "terrain-height.u16.bin"
	DefaultMetadataFile         = "terrain.json"
	LegacyOrthophotoAsset       = "terrain-ortho.rgba.bin.gz"
	DefaultMaxEdge              = 1536
	DefaultVerticalExaggeration = 1.0
	ExpectedEPSG                = 25831
	DefaultDEMResolution        = 2.0
	DefaultOrthophotoPresetID   = "8k"
)

var DefaultOrthophotoPresets = []OrthophotoPreset{
	{ID: "2k", MaxEdge: 2048},
	{ID: "4k", MaxEdge: 4096},
	{ID: "8k", MaxEdge: 8192},
}

func orthophotoOutputFile(presetID string) string {
	return fmt.Sprintf("terrain-ortho-%s.rgba.bin.gz", presetID)
}

func ParsePositiveInt(value string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 2 {
		return 0, fmt.Errorf("invalid positive integer %q", value)
	}
	return parsed, nil
}

func resolveOptions(options Options) (Options, error) {
	if options.RepoRoot == "" {
		options.RepoRoot = "."
	}
	if options.DataDir == "" {
		options.DataDir = DefaultDataDir
	}
	if options.OutputDir == "" {
		options.OutputDir = DefaultOutputDir
	}
	if options.MaxEdge == 0 {
		options.MaxEdge = DefaultMaxEdge
	}
	if options.MaxEdge < 2 {
		return options, fmt.Errorf("invalid --max-edge value %d", options.MaxEdge)
	}
	if len(options.OrthophotoPresets) == 0 {
		options.OrthophotoPresets = append([]OrthophotoPreset(nil), DefaultOrthophotoPresets...)
	}
	if options.DefaultOrthophotoID == "" {
		options.DefaultOrthophotoID = DefaultOrthophotoPresetID
	}
	if options.ExpectedDEMResolution == 0 {
		options.ExpectedDEMResolution = DefaultDEMResolution
	}

	options.RepoRoot = filepath.Clean(options.RepoRoot)
	options.DataDir = resolvePath(options.RepoRoot, options.DataDir)
	options.OutputDir = resolvePath(options.RepoRoot, options.OutputDir)

	return options, nil
}

func resolvePath(repoRoot, pathValue string) string {
	if filepath.IsAbs(pathValue) {
		return filepath.Clean(pathValue)
	}
	return filepath.Join(repoRoot, pathValue)
}
