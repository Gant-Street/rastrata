#!/bin/sh
# Install Rastrata for the person running this: the programs go in ~/.local/bin, the login service
# is set up and started, and the address to open is printed. It needs no network, no root and no
# other software, and it changes nothing outside your own home directory.
#
#   ./install.sh                    install, or install again over an older copy
#   ./install.sh --port 7300        listen on another port (7278 is the default)
#   ./install.sh --data-dir DIR     keep your books somewhere other than the default place
#
# Your books are never touched: they live in your data directory, which this only creates. To see
# what is where, run: rastrata status. To remove Rastrata later: rastrata uninstall.
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
for name in rastrata-service rastrata; do
  # Copy beside the old file and rename over it, so a running copy is never half replaced.
  temporary="$bin/.$name.new.$$"
  cp "$here/bin/$name" "$temporary"
  chmod 755 "$temporary"
  mv -f "$temporary" "$bin/$name"
done

if ! "$bin/rastrata" version >/dev/null 2>&1; then
  fail "$bin/rastrata does not run here. On macOS, a package that came from a download can be blocked: run  xattr -dr com.apple.quarantine \"$here\"  and try again."
fi

# The login service, from the templates inside the program: written, loaded, started, and waited for.
"$bin/rastrata" install --format text "$@"

case ":${PATH:-}:" in
  *":$bin:"*) ;;
  *)
    say ""
    say "To use the rastrata command, add $bin to your PATH. In zsh or bash:"
    say "  echo 'export PATH=\"$bin:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc, then open a new terminal"
    ;;
esac
