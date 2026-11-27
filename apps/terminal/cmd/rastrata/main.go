package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/cli"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/tui"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	runner := cli.Runner{Input: os.Stdin, Output: os.Stdout, Diagnostics: os.Stderr, TUI: func(client *api.Client) error { return tui.Run(ctx, client) }}
	os.Exit(runner.Run(ctx, os.Args[1:]))
}
