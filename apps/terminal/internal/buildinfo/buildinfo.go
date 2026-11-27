// Package buildinfo says what kind of build this program is. A build made from the repository is a
// development build; the one in the install package is stamped as installed, which changes where it
// looks for the service and its owner key (see internal/service). The package script sets these with
// -ldflags "-X .../buildinfo.Version=0.1.0 -X .../buildinfo.Channel=installed".
package buildinfo

// Version is the release. It must equal "version" in the repository's package.json; a test checks it.
var Version = "0.1.0"

// Channel is "development" for a build from the repository and "installed" for the package.
var Channel = "development"

// Commit is the repository revision the package was built from, when the package script knows it.
var Commit = ""

// Edition is "whole" for a build that has a service beside it on this computer (the repository's, and the package with the
// service) and "cli" for the command line on its own, which works on a hosted workspace and has no service here. The package
// script sets it with -X .../buildinfo.Edition=cli.
var Edition = "whole"

// Installed reports whether this is the packaged build.
func Installed() bool { return Channel == "installed" }

// CommandLineOnly reports whether this is the command line on its own: its books are in a hosted workspace, so it has no
// service, data directory or owner key on this computer to look after.
func CommandLineOnly() bool { return Edition == "cli" }
