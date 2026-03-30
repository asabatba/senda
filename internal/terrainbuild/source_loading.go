package terrainbuild

import (
	"math"
	"sync"
)

func openDEMSources(paths []string, expectedResolution float64) ([]*demSource, Bounds, *float64, error) {
	sources := make([]*demSource, len(paths))
	var firstErr error
	var errMu sync.Mutex
	var wg sync.WaitGroup

	for index, path := range paths {
		wg.Add(1)
		go func(index int, path string) {
			defer wg.Done()
			source, err := openDemSource(path)
			if err == nil {
				err = validateDEM(source, expectedResolution)
			}
			if err != nil {
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				errMu.Unlock()
				return
			}
			sources[index] = source
		}(index, path)
	}
	wg.Wait()
	if firstErr != nil {
		closeDEMReaders(compactDEMSources(sources))
		return nil, Bounds{}, nil, firstErr
	}

	var mergedBounds Bounds
	var mergedBoundsSet bool
	var noDataValue *float64
	for _, source := range sources {
		if source.Metadata.NoData != nil {
			if noDataValue == nil {
				copyValue := *source.Metadata.NoData
				noDataValue = &copyValue
			} else if math.Abs(*noDataValue-*source.Metadata.NoData) > 1e-6 {
				closeDEMReaders(sources)
				return nil, Bounds{}, nil, errNoDataMismatch(source, *noDataValue)
			}
		}
		if mergedBoundsSet {
			mergedBounds = expandBounds(mergedBounds, source.Metadata.Bounds)
		} else {
			mergedBounds = source.Metadata.Bounds
			mergedBoundsSet = true
		}
	}
	return sources, mergedBounds, noDataValue, nil
}

func openOrthophotoSources(paths []string) ([]*orthophotoSource, error) {
	sources := make([]*orthophotoSource, len(paths))
	var firstErr error
	var errMu sync.Mutex
	var wg sync.WaitGroup

	for index, path := range paths {
		wg.Add(1)
		go func(index int, path string) {
			defer wg.Done()
			source, err := openOrthophotoSource(path)
			if err == nil {
				err = validateOrthophoto(source)
			}
			if err != nil {
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				errMu.Unlock()
				return
			}
			sources[index] = source
		}(index, path)
	}
	wg.Wait()
	if firstErr != nil {
		closeOrthophotoReaders(compactOrthophotoSources(sources))
		return nil, firstErr
	}
	return sources, nil
}

func compactDEMSources(sources []*demSource) []*demSource {
	out := make([]*demSource, 0, len(sources))
	for _, source := range sources {
		if source != nil {
			out = append(out, source)
		}
	}
	return out
}

func compactOrthophotoSources(sources []*orthophotoSource) []*orthophotoSource {
	out := make([]*orthophotoSource, 0, len(sources))
	for _, source := range sources {
		if source != nil {
			out = append(out, source)
		}
	}
	return out
}
