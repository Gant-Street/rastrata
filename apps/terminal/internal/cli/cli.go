package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/buildinfo"
)

type Options struct {
	Endpoint, BookID, Directory, Input, OperationID, Format, AsOf, Revision string
	// Workspace selects a connected workspace by alias, slug, ID or name (--workspace or RASTRATA_WORKSPACE).
	Workspace string
	// WorkspaceID is populated when a named/folder connection resolves to a hosted workspace.
	WorkspaceID string
	// FormatGiven is true when --format was written, since json is also the default.
	FormatGiven bool
	// EndpointGiven is true when the person named the service, with RASTRATA_API_URL or --endpoint: a folder's connection (rastrata connect) is then used only if it is to that address.
	EndpointGiven bool
	Help          bool
	Args          []string
	// Flags holds options only a registered command understands (see commands.go), as written:
	// "--account" maps to "account". Write them as --name=value; a bare --name means "true".
	Flags map[string]string
}
type Runner struct {
	Input               io.Reader
	Output, Diagnostics io.Writer
	TUI                 func(*api.Client) error
}

var builtinOptions = map[string]bool{
	"--endpoint": true, "--book": true, "--workspace": true, "--request-dir": true, "--input": true,
	"--operation-id": true, "--format": true, "--as-of": true, "--revision": true,
}

func defaults() Options {
	directory, _ := os.UserCacheDir()
	endpoint := os.Getenv("RASTRATA_API_URL")
	if endpoint == "" {
		endpoint = defaultEndpoint()
	}
	book := os.Getenv("RASTRATA_BOOK_ID")
	if book == "" {
		book = "local-book"
	}
	requests := os.Getenv("RASTRATA_REQUEST_DIR")
	if requests == "" {
		requests = filepath.Join(directory, "rastrata", "requests")
	}
	return Options{
		Endpoint:      endpoint,
		EndpointGiven: os.Getenv("RASTRATA_API_URL") != "",
		BookID:        book,
		Workspace:     strings.TrimSpace(os.Getenv("RASTRATA_WORKSPACE")),
		Directory:     requests,
		Format:        "json",
	}
}
func parse(args []string) (Options, error) {
	options := defaults()
	options.Flags = map[string]string{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--json" {
			options.Format = "json"
			continue
		}
		if arg == "--help" || arg == "-h" {
			options.Help = true
			continue
		}
		if !strings.HasPrefix(arg, "--") {
			options.Args = append(options.Args, arg)
			continue
		}
		key, value, has := strings.Cut(arg, "=")
		if !builtinOptions[key] {
			if !has {
				value = "true"
				if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
					i++
					value = args[i]
				}
			}
			options.Flags[strings.TrimPrefix(key, "--")] = value
			continue
		}
		if !has {
			if i+1 >= len(args) {
				return options, fmt.Errorf("missing value for %s", key)
			}
			i++
			value = args[i]
		}
		switch key {
		case "--endpoint":
			options.Endpoint = value
			options.EndpointGiven = true
		case "--book":
			options.BookID = value
		case "--workspace":
			options.Workspace = strings.TrimSpace(value)
		case "--request-dir":
			options.Directory = value
		case "--input":
			options.Input = value
		case "--operation-id":
			options.OperationID = value
		case "--format":
			options.Format = value
			options.FormatGiven = true
		case "--as-of":
			options.AsOf = value
		case "--revision":
			options.Revision = value
		}
	}
	if options.Format != "json" && options.Format != "csv" && options.Format != "text" {
		return options, errors.New("format must be json, text or csv")
	}
	return options, nil
}
func (r Runner) localError(options Options, code, message string, exit int) int {
	response := api.Response{Version: api.Version, BookID: options.BookID, OperationID: options.OperationID, Error: &api.Failure{Code: code, Message: message, Details: []api.FieldError{}, Retryable: false}}
	_ = json.NewEncoder(r.Output).Encode(response)
	fmt.Fprintln(r.Diagnostics, message)
	return exit
}
func (r Runner) Run(ctx context.Context, args []string) int {
	options, err := parse(args)
	if err != nil {
		return r.localError(options, "usage_error", err.Error(), 2)
	}
	if len(options.Flags) > 0 && firstArg(options) != "schema" {
		if _, registered := lookupCommand(options.Args); !registered {
			names := make([]string, 0, len(options.Flags))
			for name := range options.Flags {
				names = append(names, name)
			}
			sort.Strings(names)
			return r.localError(options, "usage_error", "unknown option --"+names[0], 2)
		}
	}
	if options.Help || (len(options.Args) > 1 && options.Args[0] == "help") {
		if exit, shown := r.commandHelp(options); shown {
			return exit
		}
	}
	if len(options.Args) == 0 || options.Help || options.Args[0] == "help" {
		return r.help(options)
	}
	if options.Args[0] == "version" {
		fmt.Fprintln(r.Output, "rastrata "+buildinfo.Version+" ("+api.Version+")")
		return 0
	}
	if options.Args[0] == "schema" {
		return r.schemaCommand(ctx, options)
	}
	if command, registered := lookupCommand(options.Args); registered && command.Local && buildinfo.CommandLineOnly() {
		return r.localError(options, "not_in_this_package", "rastrata "+command.Name+" is not part of the command line on its own, which has no service on this computer. Your books are in your workspace at "+hostedEndpoint+"/; rastrata agent status says who your token is and what it may do.", 2)
	}
	if command, registered := lookupCommand(options.Args); registered && command.Offline {
		return command.Run(r, ctx, options, nil)
	}
	// An agent token (RASTRATA_TOKEN) or the owner key file (RASTRATA_OWNER_KEY_FILE), if either is
	// set; the token wins. Otherwise what `rastrata connect` kept for this folder, which also says where the
	// books are (commands_connect.go). The credential is sent to the service it is for and nowhere else: an owner key
	// or a token made on this computer only to this computer, and the key of a hosted workspace's agent
	// only to the hosted service, which exchanges it for a short-lived token (api/exchange.go).
	credential, _, err := credentialFor(&options)
	if err != nil {
		return r.localError(options, "usage_error", err.Error(), 2)
	}
	client, err := api.New(options.Endpoint, options.BookID, options.Directory)
	if err != nil {
		return r.localError(options, "usage_error", err.Error(), 2)
	}
	client.Credential = credential
	client.WorkspaceID = options.WorkspaceID
	if options.Directory != "" {
		if filepath.Base(options.Directory) == "requests" {
			client.TokenCacheDir = filepath.Join(filepath.Dir(options.Directory), "tokens")
		} else {
			client.TokenCacheDir = filepath.Join(options.Directory, ".tokens")
		}
	}
	if options.Args[0] == "tui" {
		if len(options.Args) != 1 || options.Input != "" {
			return r.localError(options, "usage_error", "tui takes only connection options", 2)
		}
		if r.TUI == nil {
			return r.localError(options, "tui_unavailable", "Interactive presentation is unavailable in this runner", 2)
		}
		if err := r.TUI(client); err != nil {
			return r.localError(options, "tui_unavailable", err.Error(), 2)
		}
		return 0
	}
	if command, registered := lookupCommand(options.Args); registered {
		return command.Run(r, ctx, options, client)
	}
	if len(options.Args) > 1 && options.Args[0] == "operations" {
		switch options.Args[1] {
		case "resume":
			if len(options.Args) != 3 {
				return r.localError(options, "usage_error", "Use operations resume OPERATION_ID", 2)
			}
			response, err := client.Resume(ctx, options.Args[2])
			return r.result(options, response, err, "")
		case "requests":
			if len(options.Args) != 2 {
				return r.localError(options, "usage_error", "Use operations requests", 2)
			}
			records, err := client.Journal.ListForWorkspace(client.Endpoint, client.BookID, client.WorkspaceID)
			if err != nil {
				return r.localError(options, "request_journal_unavailable", err.Error(), 4)
			}
			data, _ := json.Marshal(records)
			return r.result(options, api.Response{Version: api.Version, BookID: client.BookID, OK: true, Data: data}, nil, "")
		}
	}
	operation, seed, statement, err := resolve(options)
	if err != nil {
		return r.localError(options, "usage_error", err.Error(), 2)
	}
	input := seed
	if options.Input != "" {
		reader := r.Input
		if options.Input != "-" {
			file, err := os.Open(options.Input)
			if err != nil {
				return r.localError(options, "input_unavailable", err.Error(), 2)
			}
			defer file.Close()
			reader = file
		}
		raw, err := io.ReadAll(io.LimitReader(reader, 131073))
		if err != nil || len(raw) > 131072 {
			return r.localError(options, "invalid_input", "Input is unreadable or exceeds 128 KiB", 2)
		}
		var decoded map[string]json.RawMessage
		if err := json.Unmarshal(raw, &decoded); err != nil || decoded == nil {
			return r.localError(options, "invalid_input", "Input must be one JSON object", 2)
		}
		for key, value := range decoded {
			input[key] = value
		}
	}
	if strings.HasPrefix(operation, "reports.") {
		if options.AsOf != "" {
			input["asOf"] = options.AsOf
		}
		if options.Revision != "" {
			input["revision"] = options.Revision
		}
	}
	if options.Format == "csv" {
		return r.localError(options, "usage_error", reportsCSVHint, 2)
	}
	definition, _ := api.FindOperation(operation)
	if definition.Writes && operation != "operations.commit" && options.OperationID == "" {
		options.OperationID = api.NewOperationID()
	}
	if definition.Writes {
		fmt.Fprintf(r.Diagnostics, "Retaining %s for %s; use operations requests or operations resume after interruption.\n", options.OperationID, operation)
	}
	response, err := client.Call(ctx, operation, input, options.OperationID)
	return r.result(options, response, err, statement)
}

var aliases = map[string]string{"context": "book.get", "book get": "book.get", "book setup": "book.setup", "capabilities": "capabilities.get", "accounts list": "accounts.list", "accounts prepare-create": "accounts.prepareCreate", "accounts prepare-change": "accounts.prepareChange", "sources list": "sources.list", "drafts list": "drafts.list", "drafts create": "drafts.create", "drafts save": "drafts.save", "drafts recover": "drafts.recover", "drafts discard": "drafts.discard", "journal list": "journal.list", "journal prepare": "journal.prepare", "journal prepare-reverse": "journal.prepareReverse", "activity": "activity.get", "periods list": "periods.list", "periods prepare": "periods.prepare", "operations commit": "operations.commit"}

func resolve(o Options) (string, map[string]any, string, error) {
	args := o.Args
	input := map[string]any{}
	if args[0] == "call" {
		if len(args) != 2 {
			return "", nil, "", errors.New("Use call OPERATION --input FILE (or - for stdin)")
		}
		if _, exists := api.FindOperation(args[1]); !exists {
			return "", nil, "", errors.New("Unknown operation; see help")
		}
		return args[1], input, "", nil
	}
	key := strings.Join(args, " ")
	if operation, exists := aliases[key]; exists {
		return operation, input, "", nil
	}
	if len(args) == 3 && (args[0] == "drafts" || args[0] == "journal" || args[0] == "sources") && args[1] == "get" {
		field, operation := "draftId", "drafts.get"
		if args[0] == "journal" {
			field, operation = "journalId", "journal.get"
		}
		if args[0] == "sources" {
			field, operation = "sourceId", "sources.get"
		}
		input[field] = args[2]
		return operation, input, "", nil
	}
	if len(args) == 3 && args[0] == "operations" && args[1] == "status" {
		input["operationId"] = args[2]
		return "operations.get", input, "", nil
	}
	if len(args) == 4 && args[0] == "operations" && args[1] == "commit" {
		input["planId"] = args[2]
		input["planHash"] = args[3]
		return "operations.commit", input, "", nil
	}
	return "", nil, "", unknownCommand(args)
}
func (r Runner) result(o Options, response api.Response, err error, statement string) int {
	if err != nil {
		var failure *api.Error
		if errors.As(err, &failure) {
			response = failure.Response
		} else {
			return r.localError(o, "client_error", err.Error(), 4)
		}
		_ = json.NewEncoder(r.Output).Encode(response)
		fmt.Fprintln(r.Diagnostics, err)
		switch response.Error.Code {
		case "operation_unresolved":
			return 5
		case "response_invalid":
			if response.OperationID != "" {
				return 5
			}
			return 4
		case "connection_failed", "service_unavailable":
			return 4
		case "invalid_input", "invalid_operation_id", "request_too_large", "unknown_operation", "request_journal_conflict", "request_journal_unwritable":
			return 2
		default:
			return 3
		}
	}
	exit := 0
	var disposition struct {
		Disposition string `json:"disposition"`
		Valid       *bool  `json:"valid"`
	}
	_ = json.Unmarshal(response.Data, &disposition)
	if disposition.Disposition == "rejected" || disposition.Disposition == "unresolved" || (disposition.Valid != nil && !*disposition.Valid) {
		exit = 3
	}
	if disposition.Disposition == "unresolved" {
		exit = 5
	}
	if o.Format == "csv" {
		return r.localError(o, "usage_error", reportsCSVHint, 2)
	}
	if statement != "" {
		response.Data = reportsNarrow(response.Data, statement)
	}
	if o.Format == "text" {
		var formatted bytes.Buffer
		if err := json.Indent(&formatted, response.Data, "", "  "); err != nil {
			fmt.Fprintln(r.Output, string(response.Data))
		} else {
			fmt.Fprintln(r.Output, formatted.String())
		}
	} else {
		_ = json.NewEncoder(r.Output).Encode(response)
	}
	return exit
}

// Text mode is deliberately plain and safe for accessible terminals. The TUI
// supplies dense tables; JSON mode always emits one complete envelope.

func (r Runner) schema(o Options) int {
	if len(o.Args) == 1 {
		_, err := r.Output.Write(append(api.SchemaJSON, '\n'))
		if err != nil {
			return 4
		}
		return 0
	}
	if len(o.Args) != 2 {
		return r.localError(o, "usage_error", "Use schema [OPERATION]", 2)
	}
	operation, exists := api.FindOperation(o.Args[1])
	if !exists {
		return r.localError(o, "unknown_operation", "Operation is not in the catalog", 2)
	}
	var contract map[string]json.RawMessage
	_ = json.Unmarshal(api.SchemaJSON, &contract)
	_ = json.NewEncoder(r.Output).Encode(map[string]any{"version": api.Version, "operation": operation, "stability": api.Stability(operation.Name), "$defs": contract["$defs"]})
	return 0
}

// commandHelp answers a question about one command by name (`rastrata inbox list --help`,
// `rastrata help inbox list`, `rastrata call inbox.list --help`): its usage line, or the operation
// behind it and where its exact input is described. Asking about a command is not asking for the
// whole manual, which is long, so the manual is printed only when nothing named is known.
func (r Runner) commandHelp(o Options) (int, bool) {
	words := o.Args
	if len(words) > 0 && words[0] == "help" {
		words = words[1:]
	}
	if len(words) == 0 {
		return 0, false
	}
	if command, registered := lookupCommand(words); registered {
		fmt.Fprintf(r.Output, "rastrata %s\n  %s\n\nWrite options as --name=value. Every command and option: rastrata help.\n", command.Name, command.Summary)
		return 0, true
	}
	name := strings.Join(words, " ")
	if len(words) == 2 && words[0] == "call" {
		name = words[1]
		if operation, exists := api.FindOperation(name); exists {
			fmt.Fprintf(r.Output, "rastrata call %s --input -\n  %s\n  Needs the %s permission. Its exact input and output: rastrata schema %s. Give the input as one JSON object on standard input.\n", operation.Name, operation.Description, operation.Permission, operation.Name)
			return 0, true
		}
	}
	if operation, exists := aliases[name]; exists {
		fmt.Fprintf(r.Output, "rastrata %s runs the operation %s.\n  Its exact input and output: rastrata schema %s. Give the input as one JSON object with --input FILE (or - for standard input).\n", name, operation, operation)
		return 0, true
	}
	return 0, false
}

// unknownCommand is the error for words that name no command. When the first word is a command
// group (`inbox`, `rules`), it says which commands the group has, so the next try is not a guess.
func unknownCommand(args []string) error {
	message := "Unknown command or missing arguments; run rastrata help"
	if len(args) == 0 {
		return errors.New(message)
	}
	prefix := args[0] + " "
	verbs := map[string]bool{}
	for name := range commands {
		if strings.HasPrefix(name, prefix) {
			verbs[strings.TrimPrefix(name, prefix)] = true
		}
	}
	for words := range aliases {
		if strings.HasPrefix(words, prefix) {
			verbs[strings.TrimPrefix(words, prefix)] = true
		}
	}
	if len(verbs) == 0 {
		return errors.New(message)
	}
	names := make([]string, 0, len(verbs))
	for verb := range verbs {
		names = append(names, verb)
	}
	sort.Strings(names)
	return fmt.Errorf("%s. The %s commands are: %s. `rastrata %s %s --help` shows one command's options", message, args[0], strings.Join(names, ", "), args[0], names[0])
}

func (r Runner) help(o Options) int {
	fmt.Fprintln(r.Output, `Rastrata — manual bookkeeping through one shared application service

  context | capabilities | schema [OPERATION] | version
  book setup --input setup.json
  accounts list | prepare-create | prepare-change
  drafts list | get ID | create | save | discard
  journal list | get ID | prepare | prepare-reverse
  reports STATEMENT --as-of YYYY-MM-DD   (see Commands below; --format csv for a spreadsheet)
  activity --input scope.json
  periods list | prepare
  operations status ID | commit ID HASH | resume ID | requests
  call OPERATION --input FILE
  tui                         Explicitly start the interactive client

Inputs are JSON objects matching 'schema OPERATION'; --input - reads stdin.
Writes retain their identity and exact bytes before dispatch. Review a prepared
plan, then commit its planId and planHash. Resume never prepares a new command.
Opening balances use an ordinary balanced journal against an equity offset.

Options (before or after commands):
  --endpoint URL              `+endpointHelp()+`
  --workspace SLUG|ID         Select a connected workspace (or set RASTRATA_WORKSPACE)
  --book ID                   Explicit book scope (default local-book)
  --input FILE|-              One JSON input object; never opens a prompt
  --operation-id UUID         Reuse only for identical input
  --request-dir DIR           Private durable request journal
  --format json|text|csv       JSON is default; CSV is for one report statement
  --as-of DATE --revision N   Report cutoff and optional pinned revision
  --json                      Explicit JSON mode; clean stdout, no ANSI

`+serviceHelp()+accessHelp()+`Exit codes: 0 success, 2 usage/input, 3 rejection/conflict/denied,
            4 connection/client failure, 5 unresolved write.

Commands (see 'schema' for the operations behind them):`)
	names := make([]string, 0, len(commands))
	for name, command := range commands {
		if command.Local && buildinfo.CommandLineOnly() {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(r.Output, "  %-26s %s\n", name, commands[name].Summary)
	}
	fmt.Fprintln(r.Output, `
Application operations (stable ones will not break within this contract version; previews may change):`)
	for _, operation := range api.Catalog() {
		mode := "read"
		if operation.Writes {
			mode = "write"
		}
		fmt.Fprintln(r.Output, operationLine(operation, mode, api.Stability(operation.Name)))
	}
	fmt.Fprintf(r.Output, "\nConnection: %s  Book: %s\n", o.Endpoint, o.BookID)
	return 0
}

// operationLine is one line of the operation list in help. A deprecated operation says so first.
func operationLine(operation api.Operation, mode, stability string) string {
	description := operation.Description
	if operation.Deprecated != "" {
		description = "Deprecated: " + operation.Deprecated + " " + description
	}
	return fmt.Sprintf("  %-26s %-5s %-9s %-7s %s", operation.Name, mode, operation.Permission, stability, description)
}
