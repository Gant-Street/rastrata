package service

import (
	"context"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// A login item made with a custom data directory records it as RASTRATA_DATA_DIR in the unit. The
// command line, run from a shell that does not have that variable, must still look where the service
// looks, so it reads the unit's value back. The unit is written by RenderLaunchd and RenderSystemd,
// so what is read here is in the format they write.

var (
	launchdDataDir = regexp.MustCompile(`<key>RASTRATA_DATA_DIR</key>\s*<string>([^<]*)</string>`)
	systemdDataDir = regexp.MustCompile(`(?m)^Environment="RASTRATA_DATA_DIR=((?:[^"\\]|\\.)*)"\s*$`)
)

// unquoteSystemd undoes systemdQuote for the inside of a quoted word.
func unquoteSystemd(text string) string {
	return strings.NewReplacer(`\\`, `\`, `\"`, `"`, "$$", "$", "%%", "%", `\n`, "\n").Replace(text)
}

// UnitDataDirectory is the RASTRATA_DATA_DIR recorded in the installed unit, or "" when there is no
// unit or it names none (the default place).
func UnitDataDirectory(goos, home string, getenv Environment) string {
	manager, err := NewManager(ManagerOptions{GOOS: goos, Home: home, Env: getenv, Runner: unusedRunner{}, Label: strings.TrimSpace(getenv(ServiceLabelVariable))})
	if err != nil {
		return ""
	}
	text, err := os.ReadFile(manager.UnitPath())
	if err != nil {
		return ""
	}
	var value string
	switch goos {
	case "darwin":
		if match := launchdDataDir.FindSubmatch(text); match != nil {
			value = html.UnescapeString(string(match[1]))
		}
	default:
		if match := systemdDataDir.FindSubmatch(text); match != nil {
			value = unquoteSystemd(string(match[1]))
		}
	}
	if value == "" || !filepath.IsAbs(value) {
		return ""
	}
	return filepath.Clean(value)
}

// unusedRunner is for the places that need a Manager only for its paths.
type unusedRunner struct{}

func (unusedRunner) Run(context.Context, string, ...string) (Output, error) {
	return Output{}, nil
}
