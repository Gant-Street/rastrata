#!/bin/sh
# Install the Rastrata command line for the person running this: the program goes in ~/.local/bin and nothing else
# is set up. It is for an agent, or a person, who works on a hosted workspace (app.rastrata.com): there is no service
# here, no login item and no network use. It needs no root and no other software, and it changes nothing outside your
# own home directory.
#
#   ./install.sh                    install, or install again over an older copy
#
# To use it on a hosted workspace, make a token on the workspace's Agents page and give it to the command in the
# environment (the guide on that page says how). To remove it later: delete ~/.local/bin/rastrata.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

if [ "$(id -u)" -eq 0 ]; then
  fail "run this as yourself, not as root or with sudo. Rastrata is installed for one person."
fi
if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
  fail "HOME is not set to a directory, so there is nowhere to install to."
fi

# This package is for one kind of computer.
want=$(cat "$here/PLATFORM")
case "$(uname -s)" in
  Darwin) system=darwin ;;
  Linux) system=linux ;;
  *) system=$(uname -s | tr '[:upper:]' '[:lower:]') ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) machine=arm64 ;;
  x86_64 | amd64) machine=amd64 ;;
  *) machine=$(uname -m) ;;
esac
if [ "$system-$machine" != "$want" ]; then
  fail "this package is for $want, and this computer is $system-$machine."
fi

# The files are the ones that were built.
if command -v shasum >/dev/null 2>&1; then
  check="shasum -a 256 -c"
elif command -v sha256sum >/dev/null 2>&1; then
  check="sha256sum -c"
else
  fail "neither shasum nor sha256sum is available to check the package."
fi
(cd "$here" && $check SHA256SUMS >/dev/null 2>&1) ||
  fail "the files do not match SHA256SUMS: the package was damaged or changed. Download it again."

bin="${RASTRATA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin"
# Copy beside the old file and rename over it, so a running copy is never half replaced.
temporary="$bin/.rastrata.new.$$"
cp "$here/bin/rastrata" "$temporary"
chmod 755 "$temporary"
mv -f "$temporary" "$bin/rastrata"

if ! "$bin/rastrata" version >/dev/null 2>&1; then
  fail "$bin/rastrata does not run here. On macOS, a package that came from a download can be blocked: run  xattr -dr com.apple.quarantine \"$here\"  and try again."
fi

say "Installed rastrata $(cat "$here/VERSION") in $bin."
say ""
say "To work on a hosted workspace, make a token on its Agents page (Settings, Agents), then in the terminal"
say "the agent will run from:"
say "  export RASTRATA_API_URL=https://app.rastrata.com"
say "  read -rs RASTRATA_TOKEN; export RASTRATA_TOKEN     # paste the token, press Enter"
say "  rastrata agent status                               # says who the token is and what it may do"
say "  rastrata agent init --agent claude                  # or codex, opencode: writes the instructions into the project"
case ":${PATH:-}:" in
  *":$bin:"*) ;;
  *)
    say ""
    say "To use the rastrata command, add $bin to your PATH. In zsh or bash:"
    say "  echo 'export PATH=\"$bin:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc, then open a new terminal"
    ;;
esac
