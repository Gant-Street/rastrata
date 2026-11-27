package cli

import (
	"context"
	"fmt"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

// Command is a subcommand with behaviour of its own: reading a file, keeping local state, a
// workflow that spans several operations. An operation that only needs a JSON input and prints
// a result needs no command; it is reachable as "call OPERATION", or through an alias.
//
// Each lane adds commands_<lane>.go and registers from init(), so lanes never edit the same file:
//
//	func init() {
//		Register(Command{Name: "backup", Summary: "...", Run: runBackup})
//	}
//
// Flags a command understands arrive in Options.Flags; write them as --name=value.
//
// A name is one word ("backup") or two ("accounts tag"); the two-word form adds a verb to a noun
// the generated aliases already use without replacing them.
type Command struct {
	Name    string
	Summary string
	// Offline commands run without a service connection (restore, agent init); c is nil.
	Offline bool
	// Local commands look after a service, or books, on this computer (install, start, doctor, restore). The command line on its
	// own has none, so it answers them with one plain sentence and leaves them out of its help.
	Local bool
	Run   func(r Runner, ctx context.Context, o Options, c *api.Client) int
}

var commands = map[string]Command{}

// Register adds a subcommand. A duplicate name is a programming error and panics at start-up.
func Register(c Command) {
	if c.Name == "" || c.Run == nil {
		panic("cli: a command needs a name and a Run function")
	}
	if _, exists := commands[c.Name]; exists {
		panic(fmt.Sprintf("cli: duplicate command %q", c.Name))
	}
	commands[c.Name] = c
}

// RegisterAlias names an operation by words: RegisterAlias("inbox list", "inbox.list").
func RegisterAlias(words, operation string) {
	if _, exists := aliases[words]; exists {
		panic(fmt.Sprintf("cli: duplicate alias %q", words))
	}
	aliases[words] = operation
}

// lookupCommand finds the command named by the leading words of args. A two-word name such as
// "accounts tag" wins over a one-word name, so a lane can add a verb to a noun the application
// operations already use ("accounts list" stays an alias for accounts.list).
func lookupCommand(args []string) (Command, bool) {
	if len(args) >= 2 {
		if command, exists := commands[args[0]+" "+args[1]]; exists {
			return command, true
		}
	}
	if len(args) >= 1 {
		command, exists := commands[args[0]]
		return command, exists
	}
	return Command{}, false
}

func firstArg(o Options) string {
	if len(o.Args) == 0 {
		return ""
	}
	return o.Args[0]
}
