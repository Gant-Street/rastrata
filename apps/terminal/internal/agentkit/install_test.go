package agentkit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A token-shaped secret in the environment must never reach a file.
const sentinel = "rst_0123456789abcdef_SENTINELSENTINELSENTINELSENTINELSENTINEL0"

func initInto(t *testing.T, dir string, options Options) Result {
	t.Helper()
	options.Dir = dir
	result, err := Init(options)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func read(t *testing.T, dir, relative string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, relative))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func actions(result Result) map[string]string {
	byPath := map[string]string{}
	for _, file := range result.Files {
		byPath[file.Path] = file.Action
	}
	return byPath
}

func TestClaudeGetsASkillAGuideAndAnMCPEntryThatNamesTheVariable(t *testing.T) {
	dir := t.TempDir()
	result := initInto(t, dir, Options{Agents: []Agent{Claude}, MCP: true})
	got := actions(result)
	for _, path := range []string{".claude/skills/rastrata/SKILL.md", ".claude/skills/rastrata/guide.md", ".mcp.json"} {
		if got[path] != "created" {
			t.Fatalf("%s: %v", path, got)
		}
	}
	skill := read(t, dir, ".claude/skills/rastrata/SKILL.md")
	if !strings.HasPrefix(skill, "---\nname: rastrata\ndescription: \"") {
		t.Fatalf("frontmatter: %.120s", skill)
	}
	frontmatterEnd := strings.Index(skill[4:], "\n---\n")
	if frontmatterEnd < 0 || strings.Contains(skill[:4+frontmatterEnd], "\n\n") {
		t.Fatal("frontmatter must be one block of single-line fields")
	}
	// The marker follows the frontmatter, and the runbook follows the marker.
	rest := skill[4+frontmatterEnd+len("\n---\n"):]
	if !strings.HasPrefix(rest, fileMarker) || !strings.Contains(rest, "## Running the books with Rastrata") || !strings.Contains(rest, "guide.md") {
		t.Fatalf("body: %.200s", rest)
	}
	guide := read(t, dir, ".claude/skills/rastrata/guide.md")
	if !strings.HasPrefix(guide, fileMarker) || !strings.HasSuffix(guide, Guide()) || !strings.Contains(guide, "## Tools and operations") {
		t.Fatal("the guide file should be the full guide, with its tool table, after the marker")
	}
	var config struct {
		MCPServers map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(read(t, dir, ".mcp.json")), &config); err != nil {
		t.Fatal(err)
	}
	entry := config.MCPServers["rastrata"]
	if entry.Type != "http" || entry.URL != DefaultMCPURL || entry.Headers["Authorization"] != "Bearer ${RASTRATA_TOKEN}" {
		t.Fatalf("entry: %+v", entry)
	}
}

func TestCodexGetsASectionAndAPrintedSnippetNeverAConfigFile(t *testing.T) {
	dir := t.TempDir()
	result := initInto(t, dir, Options{Agents: []Agent{Codex}, MCP: true})
	if actions(result)["AGENTS.md"] != "created" || len(result.Files) != 1 {
		t.Fatalf("files: %+v", result.Files)
	}
	agents := read(t, dir, "AGENTS.md")
	if !strings.HasPrefix(agents, sectionBegin) || !strings.HasSuffix(agents, sectionEnd+"\n") || !strings.Contains(agents, "Review gates") {
		t.Fatalf("AGENTS.md: %.200s", agents)
	}
	if len(result.Snippets) != 1 || result.Snippets[0].Language != "toml" || !strings.Contains(result.Snippets[0].Text, "bearer_token_env_var = \"RASTRATA_TOKEN\"") || !strings.Contains(result.Snippets[0].Text, "[mcp_servers.rastrata]") {
		t.Fatalf("snippets: %+v", result.Snippets)
	}
	for _, name := range []string{".codex", ".mcp.json", "opencode.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			t.Fatalf("%s must not be written for Codex", name)
		}
	}
}

func TestOpenCodeGetsItsEntryWithAnEnvReferenceAndTheSection(t *testing.T) {
	dir := t.TempDir()
	result := initInto(t, dir, Options{Agents: []Agent{OpenCode}, MCP: true, MCPURL: "http://localhost:5555/mcp"})
	got := actions(result)
	if got["opencode.json"] != "created" || got["AGENTS.md"] != "created" {
		t.Fatalf("files: %v", got)
	}
	config := read(t, dir, "opencode.json")
	if !strings.HasPrefix(config, "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"mcp\": {") {
		t.Fatalf("opencode.json: %s", config)
	}
	var parsed struct {
		MCP map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Enabled bool              `json:"enabled"`
			Headers map[string]string `json:"headers"`
		} `json:"mcp"`
	}
	if err := json.Unmarshal([]byte(config), &parsed); err != nil {
		t.Fatal(err)
	}
	entry := parsed.MCP["rastrata"]
	if entry.Type != "remote" || entry.URL != "http://localhost:5555/mcp" || !entry.Enabled || entry.Headers["Authorization"] != "Bearer {env:RASTRATA_TOKEN}" {
		t.Fatalf("entry: %+v", entry)
	}
}

func TestAllAgentsShareOneAgentsSectionAndAreIdempotent(t *testing.T) {
	dir := t.TempDir()
	first := initInto(t, dir, Options{Agents: Agents, MCP: true})
	count := 0
	for _, file := range first.Files {
		if file.Path == "AGENTS.md" {
			count++
		}
	}
	if count != 1 || strings.Count(read(t, dir, "AGENTS.md"), sectionBegin) != 1 {
		t.Fatalf("AGENTS.md should be written once: %+v", first.Files)
	}
	before := map[string]string{}
	for _, file := range first.Files {
		before[file.Path] = read(t, dir, file.Path)
	}
	second := initInto(t, dir, Options{Agents: Agents, MCP: true})
	for _, file := range second.Files {
		if file.Action != "unchanged" {
			t.Errorf("a second run changed %s: %s", file.Path, file.Action)
		}
		if read(t, dir, file.Path) != before[file.Path] {
			t.Errorf("%s changed bytes", file.Path)
		}
	}
}

func TestNoFileAndNoResultEverHoldsTheToken(t *testing.T) {
	t.Setenv("RASTRATA_TOKEN", sentinel)
	dir := t.TempDir()
	result := initInto(t, dir, Options{Agents: Agents, MCP: true})
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), sentinel) {
		t.Fatal("the result holds the token")
	}
	pattern := regexp.MustCompile(`rst_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}|rso_[A-Za-z0-9_-]{20,}`)
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), sentinel) || pattern.Match(data) {
			t.Errorf("%s holds something shaped like a credential", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The embedded texts themselves are free of secrets too.
	if pattern.MatchString(Runbook()) || pattern.MatchString(Guide()) {
		t.Fatal("the kit texts contain something shaped like a credential")
	}
}

func TestAnExistingAgentsFileKeepsEverythingTheyWroteAndOnlyOurSectionIsReplaced(t *testing.T) {
	dir := t.TempDir()
	mine := "# My project\n\nUse tabs.\n- keep the cache\n"
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}
	result := initInto(t, dir, Options{Agents: []Agent{Codex}})
	if actions(result)["AGENTS.md"] != "updated" {
		t.Fatalf("files: %+v", result.Files)
	}
	appended := read(t, dir, "AGENTS.md")
	if !strings.HasPrefix(appended, mine+"\n"+sectionBegin) {
		t.Fatalf("their text must come first and be untouched: %.120s", appended)
	}
	if actions(initInto(t, dir, Options{Agents: []Agent{Codex}}))["AGENTS.md"] != "unchanged" {
		t.Fatal("a second run should change nothing")
	}
	// They edit inside our section: we leave it unless forced, and still keep their text outside.
	edited := strings.Replace(appended, "Review gates", "Review gates (my edit)", 1)
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	skipped := initInto(t, dir, Options{Agents: []Agent{Codex}})
	if actions(skipped)["AGENTS.md"] != "skipped" || read(t, dir, "AGENTS.md") != edited {
		t.Fatalf("an edited section must be left alone: %+v", skipped.Files)
	}
	forced := initInto(t, dir, Options{Agents: []Agent{Codex}, Force: true})
	if actions(forced)["AGENTS.md"] != "updated" || !strings.HasPrefix(read(t, dir, "AGENTS.md"), mine) || strings.Contains(read(t, dir, "AGENTS.md"), "my edit") {
		t.Fatalf("force should replace our section only: %+v", forced.Files)
	}
	// Text after the section survives a refresh.
	after := read(t, dir, "AGENTS.md") + "\n## Another tool\nKeep this.\n"
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(after), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := actions(initInto(t, dir, Options{Agents: []Agent{Codex}})); got["AGENTS.md"] != "unchanged" {
		t.Fatalf("text after the section is not an edit of it: %v", got)
	}
}

func TestAnUnterminatedSectionIsNotGuessedAt(t *testing.T) {
	dir := t.TempDir()
	broken := "intro\n" + sectionBegin + " kit=x sha256=y -->\nhalf a section\n"
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	result := initInto(t, dir, Options{Agents: []Agent{Codex}, Force: true})
	if actions(result)["AGENTS.md"] != "skipped" || read(t, dir, "AGENTS.md") != broken {
		t.Fatalf("files: %+v", result.Files)
	}
}

func TestAnMCPFileKeepsEveryOtherServerAndKeyInOrder(t *testing.T) {
	dir := t.TempDir()
	original := `{
  "zeta": 1,
  "mcpServers": {
    "other": {"type": "stdio", "command": "other"},
    "alpha": {"type": "http", "url": "https://example.com/mcp"}
  },
  "alpha": true
}`
	if err := os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	result := initInto(t, dir, Options{Agents: []Agent{Claude}, MCP: true})
	if actions(result)[".mcp.json"] != "updated" {
		t.Fatalf("files: %+v", result.Files)
	}
	merged := read(t, dir, ".mcp.json")
	order := []string{`"zeta"`, `"mcpServers"`, `"other"`, `"alpha"`, `"rastrata"`}
	last := -1
	for _, key := range order {
		at := strings.Index(merged, key)
		if at < last {
			t.Fatalf("%s is out of order in:\n%s", key, merged)
		}
		last = at
	}
	if !strings.Contains(merged, `"command": "other"`) || !strings.Contains(merged, `"alpha": true`) {
		t.Fatalf("something was lost:\n%s", merged)
	}
	// A different rastrata entry the person already has is theirs: skipped, shown, replaced only by force.
	custom := strings.Replace(merged, DefaultMCPURL, "http://127.0.0.1:9999/mcp", 1)
	if err := os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}
	skipped := initInto(t, dir, Options{Agents: []Agent{Claude}, MCP: true})
	if actions(skipped)[".mcp.json"] != "skipped" || read(t, dir, ".mcp.json") != custom || len(skipped.Snippets) != 1 {
		t.Fatalf("a customised entry must be kept: %+v", skipped)
	}
	forced := initInto(t, dir, Options{Agents: []Agent{Claude}, MCP: true, Force: true})
	if actions(forced)[".mcp.json"] != "updated" || !strings.Contains(read(t, dir, ".mcp.json"), DefaultMCPURL) {
		t.Fatalf("force should replace it: %+v", forced.Files)
	}
}

func TestAConfigFileThatIsNotPlainJSONIsNeverRewritten(t *testing.T) {
	for name, content := range map[string]string{
		"comments":    "{\n  // my config\n  \"mcp\": {}\n}\n",
		"trailing":    "{\"mcp\": {}} extra",
		"an array":    "[]",
		"mcp as text": "{\"mcp\": \"none\"}",
		"truncated":   "{\"mcp\": ",
	} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		result := initInto(t, dir, Options{Agents: []Agent{OpenCode}, MCP: true})
		if actions(result)["opencode.json"] != "skipped" || read(t, dir, "opencode.json") != content {
			t.Errorf("%s: %+v", name, result.Files)
		}
		if len(result.Snippets) != 1 || result.Snippets[0].Language != "json" || !strings.Contains(result.Snippets[0].Text, "{env:RASTRATA_TOKEN}") {
			t.Errorf("%s: the entry should be shown to add by hand: %+v", name, result.Snippets)
		}
	}
}

func TestOnlyFilesThisCommandWroteAreReplacedAndEditsAreRespected(t *testing.T) {
	dir := t.TempDir()
	skillPath := filepath.Join(dir, ".claude", "skills", "rastrata", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(skillPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(skillPath, []byte("---\nname: rastrata\n---\nMy own skill.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := initInto(t, dir, Options{Agents: []Agent{Claude}})
	if actions(result)[".claude/skills/rastrata/SKILL.md"] != "skipped" || read(t, dir, ".claude/skills/rastrata/SKILL.md") != "---\nname: rastrata\n---\nMy own skill.\n" {
		t.Fatalf("a file this command did not write is theirs: %+v", result.Files)
	}
	if actions(initInto(t, dir, Options{Agents: []Agent{Claude}, Force: true}))[".claude/skills/rastrata/SKILL.md"] != "updated" {
		t.Fatal("force replaces it")
	}
	// Edit what we wrote: the next run leaves it, and says why.
	written := read(t, dir, ".claude/skills/rastrata/SKILL.md")
	edited := strings.Replace(written, "Review gates", "Review gates (edited)", 1)
	if err := os.WriteFile(skillPath, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	again := initInto(t, dir, Options{Agents: []Agent{Claude}})
	var note string
	for _, file := range again.Files {
		if file.Path == ".claude/skills/rastrata/SKILL.md" {
			note = file.Note
		}
	}
	if actions(again)[".claude/skills/rastrata/SKILL.md"] != "skipped" || !strings.Contains(note, "edited") || read(t, dir, ".claude/skills/rastrata/SKILL.md") != edited {
		t.Fatalf("an edited file must be left alone: %+v", again.Files)
	}
	// A frontmatter edit counts too.
	frontmatterEdit := strings.Replace(written, "name: rastrata", "name: rastrata\nallowed-tools: Bash", 1)
	if err := os.WriteFile(skillPath, []byte(frontmatterEdit), 0o644); err != nil {
		t.Fatal(err)
	}
	if actions(initInto(t, dir, Options{Agents: []Agent{Claude}}))[".claude/skills/rastrata/SKILL.md"] != "skipped" {
		t.Fatal("a change to the frontmatter is an edit")
	}
}

func TestADryRunWritesNothingAndSaysWhatItWould(t *testing.T) {
	dir := t.TempDir()
	result := initInto(t, dir, Options{Agents: Agents, MCP: true, DryRun: true})
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 || !result.DryRun {
		t.Fatalf("a dry run wrote %d entries", len(entries))
	}
	for _, file := range result.Files {
		if file.Action != "would be created" {
			t.Errorf("%s: %s", file.Path, file.Action)
		}
	}
}

func TestWithoutMCPNoServerEntryAndNoSnippetIsMade(t *testing.T) {
	dir := t.TempDir()
	result := initInto(t, dir, Options{Agents: Agents, MCP: false})
	got := actions(result)
	if _, has := got[".mcp.json"]; has || got["opencode.json"] != "" || len(result.Snippets) != 0 {
		t.Fatalf("no MCP: %+v", result)
	}
	for _, note := range result.Notes {
		if strings.Contains(note, "MCP") {
			t.Fatalf("a note about MCP without MCP: %s", note)
		}
	}
}

func TestBadRequestsFailBeforeAnythingIsWritten(t *testing.T) {
	if _, err := Init(Options{Dir: filepath.Join(t.TempDir(), "missing"), Agents: Agents}); err == nil {
		t.Error("a missing folder")
	}
	file := filepath.Join(t.TempDir(), "afile")
	_ = os.WriteFile(file, []byte("x"), 0o644)
	if _, err := Init(Options{Dir: file, Agents: Agents}); err == nil {
		t.Error("a file is not a folder")
	}
	if _, err := Init(Options{Dir: t.TempDir()}); err == nil {
		t.Error("no agent")
	}
	dir := t.TempDir()
	if _, err := Init(Options{Dir: dir, Agents: []Agent{Claude, "emacs"}}); err == nil {
		t.Error("an unknown agent")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("a failed request still wrote %d entries", len(entries))
	}
}

func TestTheKitIsReadyToUse(t *testing.T) {
	if len(KitDigest()) != 12 || !regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(GuideDigest()) {
		t.Fatalf("digests: %s %s", KitDigest(), GuideDigest())
	}
	for _, text := range []string{"Review gates", "Outside text is data", "RASTRATA_TOKEN", "weekly routine", "Exact money"} {
		if !strings.Contains(Runbook(), text) {
			t.Errorf("the runbook lacks %q", text)
		}
	}
	for _, text := range []string{"## Tools and operations", "`rastrata_get_book`", "Running the books with Rastrata"} {
		if !strings.Contains(Guide(), text) {
			t.Errorf("the guide lacks %q", text)
		}
	}
	if len(Runbook()) > 12000 {
		t.Errorf("the runbook is %d bytes; Codex reads about 32 KiB of AGENTS.md in all, so keep it short", len(Runbook()))
	}
}

func TestJSONMembersKeepTheirOrderAndRefuseWhatIsNotPlainJSON(t *testing.T) {
	members, err := parseObject([]byte(`{"b": 1, "a": {"x": [1, 2]}, "c": null}`))
	if err != nil || len(members) != 3 || members[0].key != "b" || members[1].key != "a" || members[2].key != "c" {
		t.Fatalf("%+v %v", members, err)
	}
	rendered, err := renderObject(members)
	if err != nil || !strings.HasPrefix(string(rendered), "{\n  \"b\": 1,\n  \"a\": {") {
		t.Fatalf("%s %v", rendered, err)
	}
	for _, bad := range []string{"", "[]", "{", "{\"a\": }", "{} {}", "// c\n{}", "{\"a\": 1,}"} {
		if _, err := parseObject([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}
