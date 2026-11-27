package service

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// A package is rastrata-<version>-<os>-<arch>.tar.gz. Inside it is one folder of the same name with
//
//	bin/rastrata, bin/rastrata-service   the command line tool and the service
//	share/rastrata/templates/            the unit templates, for reading
//	install.sh                           the installer
//	VERSION                              the release
//	SHA256SUMS                           the SHA-256 of every other file
//
// ExtractPackage opens one without trusting it: it checks the name, the checksum file beside it, the
// shape of every entry and the SHA256SUMS inside before anything is installed.

var packagePattern = regexp.MustCompile(`^rastrata-(\d+\.\d+\.\d+)-(darwin|linux)-(arm64|amd64)\.tar\.gz$`)

const (
	maxPackageBytes = 400 << 20
	maxPackageFiles = 200
)

// Package is an extracted, verified package.
type Package struct {
	Version string
	OS      string
	Arch    string
	// Root is the extracted folder, with bin/, share/ and SHA256SUMS in it.
	Root string
}

// Bin is a file in the package's bin folder.
func (p Package) Bin(name string) string { return filepath.Join(p.Root, "bin", name) }

// ParsePackageName reads the release, the operating system and the architecture out of a package's
// file name.
func ParsePackageName(file string) (version, goos, goarch string, err error) {
	match := packagePattern.FindStringSubmatch(filepath.Base(file))
	if match == nil {
		return "", "", "", fmt.Errorf("%s is not a Rastrata package: its name should look like rastrata-0.1.0-darwin-arm64.tar.gz", filepath.Base(file))
	}
	return match[1], match[2], match[3], nil
}

// CompareVersions compares two releases like 0.1.0 and 0.10.2 number by number: negative if a is
// older than b, zero if they are the same, positive if a is newer.
func CompareVersions(a, b string) int {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for index := 0; index < 3; index++ {
		var x, y int
		if index < len(left) {
			x, _ = strconv.Atoi(left[index])
		}
		if index < len(right) {
			y, _ = strconv.Atoi(right[index])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

func fileSHA256(file string) (string, error) {
	handle, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, handle); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// checkSidecar compares the package with the .sha256 file beside it, if there is one.
func checkSidecar(archive string) error {
	text, err := os.ReadFile(archive + ".sha256")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	fields := strings.Fields(string(text))
	if len(fields) == 0 {
		return fmt.Errorf("%s.sha256 is empty", filepath.Base(archive))
	}
	actual, err := fileSHA256(archive)
	if err != nil {
		return err
	}
	if !strings.EqualFold(fields[0], actual) {
		return fmt.Errorf("%s does not match its checksum file %s.sha256: it was damaged or changed. Download it again", filepath.Base(archive), filepath.Base(archive))
	}
	return nil
}

// ExtractPackage verifies and unpacks a package into destination, which must not exist yet.
func ExtractPackage(archive, destination string) (Package, error) {
	version, goos, goarch, err := ParsePackageName(archive)
	if err != nil {
		return Package{}, err
	}
	if err := checkSidecar(archive); err != nil {
		return Package{}, err
	}
	file, err := os.Open(archive)
	if err != nil {
		return Package{}, fmt.Errorf("cannot open the package: %w", err)
	}
	defer file.Close()
	zipped, err := gzip.NewReader(bufio.NewReader(file))
	if err != nil {
		return Package{}, fmt.Errorf("%s is not a gzip file: %w", filepath.Base(archive), err)
	}
	defer zipped.Close()
	if err := os.Mkdir(destination, 0o700); err != nil {
		return Package{}, err
	}
	top := fmt.Sprintf("rastrata-%s-%s-%s", version, goos, goarch)
	reader := tar.NewReader(zipped)
	var total int64
	count := 0
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Package{}, fmt.Errorf("%s is damaged: %w", filepath.Base(archive), err)
		}
		if count++; count > maxPackageFiles {
			return Package{}, errors.New("the package has too many files to be a Rastrata package")
		}
		name := path.Clean(strings.TrimSuffix(header.Name, "/"))
		if strings.ContainsAny(header.Name, "\x00\\") || path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") || (name != top && !strings.HasPrefix(name, top+"/")) {
			return Package{}, fmt.Errorf("the package has an entry outside its own folder (%q); it is not a Rastrata package", oneLine(header.Name))
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return Package{}, err
			}
		case tar.TypeReg:
			if total += header.Size; total > maxPackageBytes || header.Size < 0 {
				return Package{}, errors.New("the package is too large to be a Rastrata package")
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return Package{}, err
			}
			mode := os.FileMode(0o644)
			if header.Mode&0o111 != 0 {
				mode = 0o755
			}
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return Package{}, err
			}
			written, err := io.Copy(out, io.LimitReader(reader, header.Size+1))
			closeErr := out.Close()
			if err != nil || closeErr != nil || written != header.Size {
				return Package{}, fmt.Errorf("%s is damaged: %q could not be read in full", filepath.Base(archive), oneLine(name))
			}
		default:
			return Package{}, fmt.Errorf("the package has an entry that is not a plain file or folder (%q); it is not a Rastrata package", oneLine(header.Name))
		}
	}
	root := filepath.Join(destination, top)
	if err := verifySums(root); err != nil {
		return Package{}, err
	}
	if text, err := os.ReadFile(filepath.Join(root, "VERSION")); err != nil || strings.TrimSpace(string(text)) != version {
		return Package{}, fmt.Errorf("the VERSION inside %s does not say %s", filepath.Base(archive), version)
	}
	return Package{Version: version, OS: goos, Arch: goarch, Root: root}, nil
}

// verifySums checks every file of the package against its SHA256SUMS: each listed file is there and
// matches, and no file is there that is not listed.
func verifySums(root string) error {
	text, err := os.ReadFile(filepath.Join(root, "SHA256SUMS"))
	if err != nil {
		return errors.New("the package has no SHA256SUMS; it is not a Rastrata package")
	}
	listed := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(text)), "\n") {
		hash, name, found := strings.Cut(strings.TrimSpace(line), "  ")
		name = strings.TrimPrefix(name, "*")
		if !found || len(hash) != 64 || name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
			return fmt.Errorf("SHA256SUMS has a line that cannot be read: %q", oneLine(line))
		}
		listed[path.Clean(name)] = strings.ToLower(hash)
	}
	for _, required := range []string{"bin/rastrata", "bin/rastrata-service", "VERSION"} {
		if _, present := listed[required]; !present {
			return fmt.Errorf("SHA256SUMS does not list %s; it is not a Rastrata package", required)
		}
	}
	names := make([]string, 0, len(listed))
	for name := range listed {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		actual, err := fileSHA256(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			return fmt.Errorf("%s is listed in SHA256SUMS but is not in the package", name)
		}
		if actual != listed[name] {
			return fmt.Errorf("%s does not match SHA256SUMS: the package was damaged or changed. Download it again", name)
		}
	}
	return filepath.WalkDir(root, func(file string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		relative, _ := filepath.Rel(root, file)
		relative = filepath.ToSlash(relative)
		if _, present := listed[relative]; !present && relative != "SHA256SUMS" {
			return fmt.Errorf("%s is in the package but not in SHA256SUMS", relative)
		}
		return nil
	})
}
