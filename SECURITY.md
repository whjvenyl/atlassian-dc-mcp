# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report via
GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"), or contact the maintainer
directly. Expect a first response within a few days.

## Deployment security notes

This server forwards per-user PATs on every request:

- Always terminate TLS in front of it — PATs transit in request headers.
- Never log request headers upstream; the audit log on stderr records
  tool, resolved username, denied flag, and latency — never credentials.
- The server stores nothing; identity is cached 5 min keyed by a SHA-256
  of the credential, never the credential itself.
- `policy.yaml` belongs to the deployment and is gitignored; keep it out
  of images unless intentionally baked in.
