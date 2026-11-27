//go:build !unix

package service

// The checks that need the Unix file system say they cannot tell on other platforms.

func FreeBytes(string) (uint64, bool)        { return 0, false }
func SameDevice(string, string) (bool, bool) { return false, false }
func OwnedBy(string, int) (bool, bool)       { return false, false }
