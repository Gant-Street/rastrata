Rastrata command line

The `rastrata` command, on its own. It is for working on a hosted workspace (app.rastrata.com) from a
terminal, with an agent such as Claude Code, Codex or opencode, or by hand. It does not install a
service: nothing runs after it is installed, and it makes no connection except the ones you tell it to.

  ./install.sh              puts `rastrata` in ~/.local/bin and prints what to do next

Then, in the terminal the agent will run from:

  export RASTRATA_API_URL=https://app.rastrata.com
  read -rs RASTRATA_TOKEN; export RASTRATA_TOKEN      the token made on the workspace's Agents page
  rastrata agent status                               who the token is and what it may do
  rastrata agent init --agent claude                  writes the instructions into the project

The token starts with rsa_ and is shown once, when it is made. Keep it in the agent's environment: never
in a file of the project, a command line or a message. It acts as the person who made it, with at most
what that person's role allows, until it ends or is revoked on the Agents page.

The command talks only to this computer and to rastrata.com; it will not send a token anywhere else.

bin/                     rastrata
SHA256SUMS               the checksum of every file; install.sh checks them before it installs
