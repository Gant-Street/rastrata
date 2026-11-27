# Contributing to Rastrata

Thank you for contributing to Rastrata.

## Licensing and Contributor License Agreement (CLA)

Rastrata uses a split license:

- **Core engine, service, web app, and proofs** (`packages/*`, `apps/api`, `apps/web`, `proofs/`): **GNU AGPLv3**
  ([LICENSE](LICENSE)).
- **CLI, MCP server, and plugin SDK** (`apps/terminal`, `apps/mcp`, `plugins/rastrata`): **MIT**
  ([LICENSE-MIT](LICENSE-MIT)).

Before a pull request can be merged, please confirm agreement to our
[Contributor License Agreement](CLA.md) in the pull request checklist. You retain copyright to your contributions and
grant Gant Street LLC permission to distribute them under the project's open-source and commercial licenses.

## Local setup

Tool versions are pinned in `.bun-version` and `.go-version`.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run test
```

For the Go CLI (`apps/terminal`):

```sh
bun run --cwd apps/terminal test
```

## Pull request guidelines

- Keep pull requests small, focused, and accompanied by tests.
- Format and lint with Biome (`bun run format`, `bun run lint`).
- Follow conventional commit titles (`feat(api): ...`, `fix(kernel): ...`, `docs: ...`, `test: ...`).
- Changes to the accounting kernel (`packages/kernel`) must preserve 100% line and function coverage and pass the
  kernel specification and proof checks.
- Report security issues privately per [SECURITY.md](SECURITY.md).
