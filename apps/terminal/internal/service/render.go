package service

import (
	"bytes"
	"embed"
	"fmt"
	"sort"
	"strings"
	"text/template"
)

// The unit templates are part of the program, so the unit that is installed is always the one this
// version of the program was written for, and the package carries the same files for anyone who
// wants to read them before installing.
//
//go:embed templates/com.rastrata.service.plist.tmpl templates/rastrata.service.tmpl
var templateFiles embed.FS

// TemplateNames are the files in templates/, which the package script copies into the package.
var TemplateNames = []string{"com.rastrata.service.plist.tmpl", "rastrata.service.tmpl"}

// Template is the text of one of the embedded unit templates.
func Template(name string) ([]byte, error) { return templateFiles.ReadFile("templates/" + name) }

const (
	// LaunchdLabel names the launchd agent; its file is ~/Library/LaunchAgents/<label>.plist.
	LaunchdLabel = "com.rastrata.service"
	// SystemdUnit names the systemd user unit; its file is ~/.config/systemd/user/<unit>.
	SystemdUnit = "rastrata.service"
)

// Spec is what a unit file needs to know.
type Spec struct {
	// Executable is the absolute path of rastrata-service.
	Executable string
	// StdioLog is where the process's own standard output and error go.
	StdioLog string
	// Environment is set in the unit: only what differs from the defaults (RASTRATA_DATA_DIR).
	Environment map[string]string
	// Label names the launchd agent; empty is the real one (LaunchdLabel).
	Label string
}

type variable struct{ Name, Value string }

type unitData struct {
	Label       string
	Executable  string
	StdioLog    string
	Environment []variable
}

func dataFor(spec Spec) unitData {
	names := make([]string, 0, len(spec.Environment))
	for name := range spec.Environment {
		names = append(names, name)
	}
	sort.Strings(names)
	label := spec.Label
	if label == "" {
		label = LaunchdLabel
	}
	data := unitData{Label: label, Executable: spec.Executable, StdioLog: spec.StdioLog}
	for _, name := range names {
		data.Environment = append(data.Environment, variable{name, spec.Environment[name]})
	}
	return data
}

// xmlEscape makes text safe inside an XML element.
func xmlEscape(text string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(text)
}

// systemdPercent doubles the percent signs of text, which systemd would take for specifiers.
func systemdPercent(text string) string { return strings.ReplaceAll(text, "%", "%%") }

// systemdQuote makes one word of a unit file: in double quotes, with the characters systemd treats
// specially in a quoted word escaped.
func systemdQuote(text string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "$", "$$", "%", "%%", "\n", `\n`).Replace(text)
	return `"` + escaped + `"`
}

func render(name string, data unitData) (string, error) {
	text, err := Template(name)
	if err != nil {
		return "", err
	}
	parsed, err := template.New(name).Funcs(template.FuncMap{
		"xml": xmlEscape, "systemdQuote": systemdQuote, "systemdPercent": systemdPercent,
	}).Option("missingkey=error").Parse(string(text))
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	if err := parsed.Execute(&out, data); err != nil {
		return "", fmt.Errorf("render %s: %w", name, err)
	}
	return out.String(), nil
}

// RenderLaunchd is the launchd agent's property list for spec.
func RenderLaunchd(spec Spec) (string, error) {
	return render("com.rastrata.service.plist.tmpl", dataFor(spec))
}

// RenderSystemd is the systemd user unit for spec.
func RenderSystemd(spec Spec) (string, error) {
	return render("rastrata.service.tmpl", dataFor(spec))
}
