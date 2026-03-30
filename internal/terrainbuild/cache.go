package terrainbuild

import (
	"crypto/sha256"
	"encoding/gob"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type cacheManager struct {
	enabled bool
	rootDir string
	stats   map[string]*CacheStat
	mu      sync.Mutex
}

type demRasterCacheEntry struct {
	Width  int
	Height int
	Raster []float32
}

type namedPlaceCandidatesCacheEntry struct {
	Candidates []namedPlaceCandidate
}

func newCacheManager(options Options) (*cacheManager, error) {
	manager := &cacheManager{
		enabled: !options.NoCache,
		rootDir: options.CacheDir,
		stats: map[string]*CacheStat{
			"dem":         {},
			"orthophoto":  {},
			"namedPlaces": {},
		},
	}
	if !manager.enabled {
		return manager, nil
	}
	if err := os.MkdirAll(manager.rootDir, 0o755); err != nil {
		return nil, err
	}
	return manager, nil
}

func (c *cacheManager) recordHit(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stats[name].Hits++
}

func (c *cacheManager) recordMiss(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stats[name].Misses++
}

func (c *cacheManager) summary() map[string]CacheStat {
	out := make(map[string]CacheStat, len(c.stats))
	for key, value := range c.stats {
		out[key] = *value
	}
	return out
}

func (c *cacheManager) loadGob(bucket, key string, dest any) bool {
	if !c.enabled {
		c.recordMiss(bucket)
		return false
	}
	path := c.cachePath(bucket, key)
	file, err := os.Open(path)
	if err != nil {
		c.recordMiss(bucket)
		return false
	}
	defer file.Close()

	if err := gob.NewDecoder(file).Decode(dest); err != nil {
		c.recordMiss(bucket)
		return false
	}
	c.recordHit(bucket)
	return true
}

func (c *cacheManager) storeGob(bucket, key string, value any) error {
	if !c.enabled {
		return nil
	}
	dir := filepath.Join(c.rootDir, bucket)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := c.cachePath(bucket, key)
	tempPath := path + ".tmp"
	file, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(file).Encode(value); err != nil {
		_ = file.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return os.Rename(tempPath, path)
}

func (c *cacheManager) cachePath(bucket, key string) string {
	return filepath.Join(c.rootDir, bucket, key+".gob")
}

func cacheKey(parts ...string) string {
	hasher := sha256.New()
	for _, part := range parts {
		_, _ = hasher.Write([]byte(part))
		_, _ = hasher.Write([]byte{0})
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func fileFingerprint(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s|%d|%d", path, info.Size(), info.ModTime().UnixNano()), nil
}
