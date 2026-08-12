# Security Policy

## Supported versions

| Version | Supported           |
| ------- | ------------------- |
| 2.x     | yes                 |
| 1.x     | no — upgrade to 2.x |

## Reporting a vulnerability

Email **security@intempt.com** with a description, affected version, and
reproduction steps. Please do not open a public issue for a vulnerability.

We aim to acknowledge within 2 business days and to ship a fix or a mitigation
plan within 30 days for a confirmed high-severity issue.

## Handling API keys

This SDK takes a public API key of the form `<prefix>.<secret>`.

- Load it from the environment or a secret manager. Never commit it.
- It is sent in an `Authorization: Basic` header. The API also accepts an
  `?apiKey=` query parameter, which the server logs as deprecated and insecure;
  this SDK never uses it.
- `ApiKeyCredentials` masks the secret in `toString()`, `util.inspect()` and
  `JSON.stringify()`, and every SDK internal is a private class field, so the
  credential is not reachable from the public object graph.
- A public key carries `users:edit` and `accounts:edit` only. Do not deploy a
  PRIVATE or ADMIN key in an application server; those grant full project
  access.
