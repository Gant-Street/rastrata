//go:build unix

package service

import (
	"os"
	"path/filepath"
	"syscall"
)

// nearest is path if it exists, else its closest parent that does: where something would be made.
func nearest(path string) string {
	for {
		if _, err := os.Stat(path); err == nil {
			return path
		}
		parent := filepath.Dir(path)
		if parent == path {
			return path
		}
		path = parent
	}
}

// FreeBytes is the space available to this user where path is (or would be made).
func FreeBytes(path string) (uint64, bool) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(nearest(path), &stat); err != nil {
		return 0, false
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), true
}

// SameDevice reports whether two places are on one disk, and whether that could be found out.
func SameDevice(a, b string) (same, known bool) {
	first, errA := os.Stat(nearest(a))
	second, errB := os.Stat(nearest(b))
	if errA != nil || errB != nil {
		return false, false
	}
	statA, okA := first.Sys().(*syscall.Stat_t)
	statB, okB := second.Sys().(*syscall.Stat_t)
	if !okA || !okB {
		return false, false
	}
	return int64(statA.Dev) == int64(statB.Dev), true
}

// OwnedBy reports whether path belongs to the user with this uid, and whether that could be found out.
func OwnedBy(path string, uid int) (owned, known bool) {
	info, err := os.Stat(path)
	if err != nil {
		return false, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false, false
	}
	return int(stat.Uid) == uid, true
}
