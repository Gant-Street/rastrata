package service

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
)

// Output is what an external command printed and how it ended.
type Output struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Runner runs an external command: launchctl, systemctl, open. An error means the command could
// not run at all (it is not installed, say); a command that ran and failed is an Output with a
// non-zero ExitCode. Tests use a double (see servicetest) so no real service manager is touched.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (Output, error)
}

// ExecRunner runs real commands.
type ExecRunner struct{}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, name string, args ...string) (Output, error) {
	command := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	out := Output{Stdout: stdout.String(), Stderr: stderr.String()}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		out.ExitCode = exit.ExitCode()
		return out, nil
	}
	return out, err
}
