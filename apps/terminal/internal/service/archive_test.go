package service_test

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/service"
)

// entry is one thing in a test package.
type entry struct {
	name     string
	content  string
	mode     int64
	typeflag byte
	link     string
}

type recipe struct {
	version, goos, goarch string
	files                 map[string]string // path under the package folder -> content
	skipSums              bool
	tamper                func(entries []entry) []entry
	versionFile           string
}

func hashOf(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// makePackage writes rastrata-<version>-<os>-<arch>.tar.gz into dir and returns its path.
func makePackage(t *testing.T, dir string, r recipe) string {
	t.Helper()
	if r.version == "" {
		r.version = "0.2.0"
	}
	if r.goos == "" {
		r.goos = "darwin"
	}
	if r.goarch == "" {
		r.goarch = "arm64"
	}
	top := fmt.Sprintf("rastrata-%s-%s-%s", r.version, r.goos, r.goarch)
	files := map[string]string{
		"bin/rastrata":         "version=" + r.version,
		"bin/rastrata-service": "version=" + r.version,
		"install.sh":           "#!/bin/sh\n",
	}
	for name, content := range r.files {
		files[name] = content
	}
	versionText := r.version
	if r.versionFile != "" {
		versionText = r.versionFile
	}
	files["VERSION"] = versionText + "\n"
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	entries := []entry{{name: top + "/", typeflag: tar.TypeDir, mode: 0o755}, {name: top + "/bin/", typeflag: tar.TypeDir, mode: 0o755}}
	var sums strings.Builder
	for _, name := range names {
		mode := int64(0o644)
		if strings.HasPrefix(name, "bin/") || name == "install.sh" {
			mode = 0o755
		}
		entries = append(entries, entry{name: top + "/" + name, content: files[name], mode: mode, typeflag: tar.TypeReg})
		fmt.Fprintf(&sums, "%s  %s\n", hashOf(files[name]), name)
	}
	if !r.skipSums {
		entries = append(entries, entry{name: top + "/SHA256SUMS", content: sums.String(), mode: 0o644, typeflag: tar.TypeReg})
	}
	if r.tamper != nil {
		entries = r.tamper(entries)
	}
	path := filepath.Join(dir, top+".tar.gz")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	zipped := gzip.NewWriter(file)
	writer := tar.NewWriter(zipped)
	for _, item := range entries {
		header := &tar.Header{Name: item.name, Mode: item.mode, Typeflag: item.typeflag, Linkname: item.link}
		if item.typeflag == tar.TypeReg {
			header.Size = int64(len(item.content))
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if item.typeflag == tar.TypeReg {
			if _, err := writer.Write([]byte(item.content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func extract(t *testing.T, r recipe) (service.Package, error) {
	t.Helper()
	dir := t.TempDir()
	return service.ExtractPackage(makePackage(t, dir, r), filepath.Join(dir, "out"))
}

func TestAGoodPackageIsExtractedAndItsProgramsCanRun(t *testing.T) {
	pkg, err := extract(t, recipe{})
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Version != "0.2.0" || pkg.OS != "darwin" || pkg.Arch != "arm64" {
		t.Fatalf("%+v", pkg)
	}
	for _, name := range []string{"rastrata", "rastrata-service"} {
		info, err := os.Stat(pkg.Bin(name))
		if err != nil || info.Mode().Perm() != 0o755 {
			t.Errorf("%s: %v %v", name, info, err)
		}
	}
	if info, _ := os.Stat(filepath.Join(pkg.Root, "VERSION")); info.Mode().Perm() != 0o644 {
		t.Errorf("a data file must not be executable: %v", info.Mode())
	}
}

func TestPackageNames(t *testing.T) {
	good := map[string][3]string{
		"rastrata-0.1.0-darwin-arm64.tar.gz":          {"0.1.0", "darwin", "arm64"},
		"/tmp/x/rastrata-10.20.30-linux-amd64.tar.gz": {"10.20.30", "linux", "amd64"},
	}
	for name, want := range good {
		version, goos, goarch, err := service.ParsePackageName(name)
		if err != nil || [3]string{version, goos, goarch} != want {
			t.Errorf("%s: %v %v %v %v", name, version, goos, goarch, err)
		}
	}
	for _, name := range []string{"rastrata.tar.gz", "rastrata-0.1-darwin-arm64.tar.gz", "rastrata-0.1.0-windows-arm64.tar.gz", "rastrata-0.1.0-darwin-arm64.zip", "other-0.1.0-darwin-arm64.tar.gz", "rastrata-0.1.0-darwin-arm64.tar.gz.sha256", "rastrata-0.1.0-darwin-riscv.tar.gz"} {
		if _, _, _, err := service.ParsePackageName(name); err == nil || !strings.Contains(err.Error(), "not a Rastrata package") {
			t.Errorf("%s must be refused: %v", name, err)
		}
	}
}

func TestVersionsAreComparedNumberByNumber(t *testing.T) {
	for _, row := range []struct {
		a, b string
		sign int
	}{{"0.1.0", "0.1.0", 0}, {"0.1.0", "0.2.0", -1}, {"0.10.0", "0.9.0", 1}, {"1.0.0", "0.99.99", 1}, {"0.1.1", "0.1.0", 1}, {"0.1", "0.1.0", 0}} {
		got := service.CompareVersions(row.a, row.b)
		if (got < 0) != (row.sign < 0) || (got > 0) != (row.sign > 0) {
			t.Errorf("%s vs %s: got %d, want sign %d", row.a, row.b, got, row.sign)
		}
	}
}

func TestTheChecksumFileBesideAPackageIsHonoured(t *testing.T) {
	dir := t.TempDir()
	archive := makePackage(t, dir, recipe{})
	bytes, _ := os.ReadFile(archive)
	sum := sha256.Sum256(bytes)
	if err := os.WriteFile(archive+".sha256", []byte(hex.EncodeToString(sum[:])+"  "+filepath.Base(archive)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ExtractPackage(archive, filepath.Join(dir, "good")); err != nil {
		t.Fatalf("a matching checksum: %v", err)
	}
	if err := os.WriteFile(archive+".sha256", []byte(strings.Repeat("0", 64)+"  x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ExtractPackage(archive, filepath.Join(dir, "bad")); err == nil || !strings.Contains(err.Error(), "does not match its checksum file") {
		t.Fatalf("a wrong checksum: %v", err)
	}
	if err := os.WriteFile(archive+".sha256", nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ExtractPackage(archive, filepath.Join(dir, "empty")); err == nil {
		t.Fatal("an empty checksum file must be refused")
	}
}

func TestAPackageThatIsNotWhatItSaysIsRefused(t *testing.T) {
	top := "rastrata-0.2.0-darwin-arm64"
	cases := map[string]struct {
		r    recipe
		want string
	}{
		"a path that climbs out": {recipe{tamper: func(e []entry) []entry {
			return append(e, entry{name: top + "/../evil", content: "x", mode: 0o755, typeflag: tar.TypeReg})
		}}, "outside its own folder"},
		"an absolute path": {recipe{tamper: func(e []entry) []entry {
			return append(e, entry{name: "/etc/evil", content: "x", mode: 0o755, typeflag: tar.TypeReg})
		}}, "outside its own folder"},
		"another top folder": {recipe{tamper: func(e []entry) []entry {
			return append(e, entry{name: "other/evil", content: "x", mode: 0o755, typeflag: tar.TypeReg})
		}}, "outside its own folder"},
		"a backslash path": {recipe{tamper: func(e []entry) []entry {
			return append(e, entry{name: top + `/..\evil`, content: "x", mode: 0o755, typeflag: tar.TypeReg})
		}}, "outside its own folder"},
		"a symbolic link": {recipe{tamper: func(e []entry) []entry {
			return append(e, entry{name: top + "/bin/link", typeflag: tar.TypeSymlink, link: "/etc/passwd", mode: 0o755})
		}}, "not a plain file or folder"},
		"a hard link": {recipe{tamper: func(e []entry) []entry {
			return append(e, entry{name: top + "/bin/hard", typeflag: tar.TypeLink, link: top + "/bin/rastrata", mode: 0o755})
		}}, "not a plain file or folder"},
		"a device": {recipe{tamper: func(e []entry) []entry {
			return append(e, entry{name: top + "/bin/dev", typeflag: tar.TypeChar, mode: 0o644})
		}}, "not a plain file or folder"},
		"a file changed after the sums were made": {recipe{tamper: func(e []entry) []entry {
			for i := range e {
				if strings.HasSuffix(e[i].name, "/bin/rastrata-service") {
					e[i].content = "version=0.2.0 and something extra"
				}
			}
			return e
		}}, "does not match SHA256SUMS"},
		"a file the sums do not list": {recipe{tamper: func(e []entry) []entry {
			return append(e, entry{name: top + "/bin/extra", content: "x", mode: 0o755, typeflag: tar.TypeReg})
		}}, "not in SHA256SUMS"},
		"a listed file that is missing": {recipe{tamper: func(e []entry) []entry {
			var kept []entry
			for _, item := range e {
				if !strings.HasSuffix(item.name, "/install.sh") {
					kept = append(kept, item)
				}
			}
			return kept
		}}, "not in the package"},
		"no sums at all":                {recipe{skipSums: true}, "no SHA256SUMS"},
		"a VERSION that says otherwise": {recipe{versionFile: "9.9.9"}, "does not say 0.2.0"},
	}
	for name, item := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := extract(t, item.r); err == nil || !strings.Contains(err.Error(), item.want) {
				t.Fatalf("want an error containing %q, got %v", item.want, err)
			}
		})
	}
}

func TestAPackageWithTooManyFilesIsRefused(t *testing.T) {
	files := map[string]string{}
	for i := 0; i < 250; i++ {
		files[fmt.Sprintf("share/f%d", i)] = "x"
	}
	if _, err := extract(t, recipe{files: files}); err == nil || !strings.Contains(err.Error(), "too many files") {
		t.Fatalf("%v", err)
	}
}

func TestSomethingThatIsNotAnArchiveIsRefusedPlainly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rastrata-0.2.0-darwin-arm64.tar.gz")
	if err := os.WriteFile(path, []byte("this is not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ExtractPackage(path, filepath.Join(dir, "out")); err == nil || !strings.Contains(err.Error(), "not a gzip file") {
		t.Fatalf("%v", err)
	}
	if _, err := service.ExtractPackage(filepath.Join(dir, "rastrata-0.3.0-darwin-arm64.tar.gz"), filepath.Join(dir, "out2")); err == nil || !strings.Contains(err.Error(), "cannot open the package") {
		t.Fatalf("missing: %v", err)
	}
}
