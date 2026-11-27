# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public GitHub issues, pull requests, or discussions.

Instead, report them privately through one of these channels:

1. **GitHub Private Vulnerability Reporting** on the
   [Gant-Street/rastrata](https://github.com/Gant-Street/rastrata/security/advisories/new) repository (preferred).
2. **Email:** `security@rastrata.com`.

Please include a clear description of the issue, the affected component or version, steps to reproduce, and any proof
of concept that helps verify the report.

## Scope

In scope:

- The accounting kernel (`packages/kernel`), ledger (`packages/ledger`), and application engine (`packages/application`)
- The local service (`rastrata-service` / `apps/api`), web app (`apps/web`), CLI (`apps/terminal`), and MCP server
  (`apps/mcp`)
- Authentication, authorization, token scoping, owner lock, backup/restore, and data integrity issues

Please avoid testing against other users' data or disrupting live services.
