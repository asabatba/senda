package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"gpx3d2/internal/terrainbuild"
)

type stringListFlag []string

func (f *stringListFlag) String() string {
	return fmt.Sprintf("%v", []string(*f))
}

func (f *stringListFlag) Set(value string) error {
	if value == "" {
		return errors.New("empty value")
	}
	*f = append(*f, value)
	return nil
}

func main() {
	repoRoot, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	maxEdgeDefault := terrainbuild.DefaultMaxEdge
	if raw := os.Getenv("TERRAIN_MAX_EDGE"); raw != "" {
		if parsed, parseErr := terrainbuild.ParsePositiveInt(raw); parseErr != nil {
			fmt.Fprintln(os.Stderr, parseErr)
			os.Exit(1)
		} else {
			maxEdgeDefault = parsed
		}
	}

	var demFiles stringListFlag
	var orthophotoFiles stringListFlag
	dataDir := flag.String("data-dir", terrainbuild.DefaultDataDir, "Directory containing source GeoTIFFs.")
	outputDir := flag.String("output-dir", terrainbuild.DefaultOutputDir, "Directory for generated browser assets.")
	maxEdge := flag.Int("max-edge", maxEdgeDefault, "Maximum mesh edge length.")
	flag.Var(&demFiles, "dem-file", "Specific DEM GeoTIFF to include. Repeatable.")
	flag.Var(&orthophotoFiles, "orthophoto-file", "Specific orthophoto GeoTIFF to include. Repeatable.")
	flag.Parse()

	summary, err := terrainbuild.Run(terrainbuild.Options{
		RepoRoot:        filepath.Clean(repoRoot),
		DataDir:         *dataDir,
		OutputDir:       *outputDir,
		MaxEdge:         *maxEdge,
		DemFiles:        demFiles,
		OrthophotoFiles: orthophotoFiles,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(summary); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
