package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Reading the folder a customer points the intake at. This is the only code of the lane that
// touches the file system, and it takes its paths from one place: the command line. The names of
// files are text from strangers and are never used to build a path; they are listed, escaped, and
// that is all.
//
// What it refuses, and says it refused:
//
//   - a symbolic link, whether it points out of the folder or into it (it is not followed, so a
//     link can neither leave the folder nor loop);
//   - a name that starts with a dot (editors and operating systems leave their own files there);
//   - anything that is not a regular file (a device, a socket, a pipe);
//   - a file larger than the upload limit, and an empty file;
//   - everything past the limits on the number of files, the folders' depth and the total size.
//
// A file is read by opening it and checking that what was opened is the file that was listed, so a
// file swapped for a link between listing and reading is refused.

// Reasons a file was not taken, a closed set the output and the tests share.
const (
	skipHidden         = "hidden"
	skipSymlink        = "symlink"
	skipSymlinkOutside = "symlink_outside"
	skipNotRegular     = "not_regular"
	skipTooLarge       = "too_large"
	skipEmpty          = "empty"
	skipOverLimit      = "over_limit"
	skipTooDeep        = "too_deep"
	skipUnreadable     = "unreadable"
)

type walkLimits struct {
	MaxFiles      int
	MaxDepth      int
	MaxFileBytes  int64
	MaxTotalBytes int64
}

type walkedFile struct {
	// Rel is the path below the folder, with forward slashes. It is a label; Abs is what is opened.
	Rel  string
	Abs  string
	Size int64
}

type skippedFile struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	Size   int64  `json:"size,omitempty"`
}

type walkResult struct {
	Root      string
	Files     []walkedFile
	Skipped   []skippedFile
	Truncated bool
}

// within reports whether target is the folder or below it.
func within(root, target string) bool {
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)))
}

// walkFolder lists the regular files below root, in name order.
func walkFolder(root string, limits walkLimits) (*walkResult, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(real)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("the path is not a folder")
	}
	result := &walkResult{Root: real}
	var total int64
	skip := func(rel, reason string, size int64) {
		if len(result.Skipped) < 500 {
			result.Skipped = append(result.Skipped, skippedFile{Path: rel, Reason: reason, Size: size})
		}
	}
	var visit func(dir, rel string, depth int)
	visit = func(dir, rel string, depth int) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			skip(rel, skipUnreadable, 0)
			return
		}
		for _, entry := range entries {
			name := entry.Name()
			childRel := path.Join(rel, name)
			if rel == "" {
				childRel = name
			}
			full := filepath.Join(dir, name)
			if strings.HasPrefix(name, ".") {
				skip(childRel, skipHidden, 0)
				continue
			}
			mode := entry.Type()
			switch {
			case mode&os.ModeSymlink != 0:
				// Never followed. Say whether it points out of the folder, so the owner knows.
				target, err := filepath.EvalSymlinks(full)
				if err != nil || !within(real, target) {
					skip(childRel, skipSymlinkOutside, 0)
				} else {
					skip(childRel, skipSymlink, 0)
				}
			case mode.IsDir():
				if depth >= limits.MaxDepth {
					skip(childRel, skipTooDeep, 0)
					continue
				}
				visit(full, childRel, depth+1)
			case mode.IsRegular():
				stat, err := entry.Info()
				if err != nil {
					skip(childRel, skipUnreadable, 0)
					continue
				}
				switch {
				case stat.Size() == 0:
					skip(childRel, skipEmpty, 0)
				case stat.Size() > limits.MaxFileBytes:
					skip(childRel, skipTooLarge, stat.Size())
				case len(result.Files) >= limits.MaxFiles || total+stat.Size() > limits.MaxTotalBytes:
					result.Truncated = true
					skip(childRel, skipOverLimit, stat.Size())
				default:
					total += stat.Size()
					result.Files = append(result.Files, walkedFile{Rel: childRel, Abs: full, Size: stat.Size()})
				}
			default:
				skip(childRel, skipNotRegular, 0)
			}
		}
	}
	visit(real, "", 0)
	return result, nil
}

// readWalked reads a listed file, refusing it if what is opened is not the regular file that was
// listed (it was replaced by a link or by something else in between).
func readWalked(file walkedFile, limit int64) ([]byte, error) {
	before, err := os.Lstat(file.Abs)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, errors.New("the file is no longer a regular file")
	}
	opened, err := os.Open(file.Abs)
	if err != nil {
		return nil, err
	}
	defer opened.Close()
	after, err := opened.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(before, after) {
		return nil, errors.New("the file changed while it was being read")
	}
	data, err := io.ReadAll(io.LimitReader(opened, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("the file is larger than %d bytes", limit)
	}
	return data, nil
}
