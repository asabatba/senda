package terrainbuild

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

var (
	demPattern        = regexp.MustCompile(`(?i)^MDT02-ETRS89-HU31-.*\.tif$`)
	orthophotoPattern = regexp.MustCompile(`(?i)^PNOA_MA_OF_ETRS89_HU31_h25_.*\.tif$`)
)

func discoverInputs(dataDir string, explicit []string, pattern *regexp.Regexp, label string) ([]string, error) {
	if len(explicit) > 0 {
		paths := make([]string, 0, len(explicit))
		for _, pathValue := range explicit {
			paths = append(paths, filepath.Clean(pathValue))
		}
		sort.Slice(paths, func(i, j int) bool {
			return filepath.Base(paths[i]) < filepath.Base(paths[j])
		})
		return paths, nil
	}

	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return nil, err
	}

	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if !pattern.MatchString(entry.Name()) {
			continue
		}
		paths = append(paths, filepath.Join(dataDir, entry.Name()))
	}
	sort.Slice(paths, func(i, j int) bool {
		return filepath.Base(paths[i]) < filepath.Base(paths[j])
	})
	if len(paths) == 0 {
		return nil, fmt.Errorf("no %s files matching %s were found in %q", label, pattern.String(), dataDir)
	}
	return paths, nil
}
