# Conventions

**The cross-SDK surface is not decided here.** Every Intempt SDK conforms to
`intempt-swift/docs/SDK-API-CONTRACT.md`, which is the single authority on method names, argument
order, defaults and what is deliberately withheld. This file covers what is specific to Node and TypeScript and
to this repo. Where the two disagree, the contract wins and this file is the bug.

## The rules that come from the contract

- **A caller asks for a KEY, never a mode.** There is no `flagVariation` / `experimentVariation`
  split. The platform resolves whether a key is an experiment, a personalization or a flag; its
  serving query filters on channel and status and never on mode. A method name that encodes the
  mode forces an integrator to know the answer before they can ask the question, and grows
  combinatorially with every mode added.
- **`defaultValue` is REQUIRED, everywhere, and is never optional.** It is what a caller receives on
  a network failure, a timeout, an unknown key or a malformed response. A flag SDK that throws when
  the service is unreachable takes the application down with it, which is the opposite of what a
  kill switch is for.
- **A wrong-typed value falls back; it is never coerced.** A flag configured as a string and read as
  a boolean returns the caller's default, not `true`. Coercion makes a misconfiguration look like a
  deliberate value.
- **`variationDetail` is NOT exposed.** It would carry a reason, and the serving response does not
  send one — so it could only report "off" for a person who was in fact targeted and served, which
  is the single thing such a method exists to tell you. It stays internal until the platform sends
  a reason. Do not re-add it, and do not document it.
- **Evaluation is REMOTE only.** No local rule engine, no flag store to poll, and no hashing
  utility: the server buckets, so no second implementation can disagree with it. `check-no-local-bucketing.mjs`
  enforces this in CI and a new bucketing helper will fail the build.
- **A validation mistake throws; a service problem does not.** A blank key or a missing default is a
  programming error the caller can fix, so it fails loudly at the call site. A 5xx is a runtime
  condition to absorb.

## Errors

Two tiers, and they are not interchangeable: a configuration mistake surfaces when the config is
built, and an API failure carries the status, the body and any `Retry-After`. A transport failure
that never produced a response carries a **null** status — read as retryable, because a request
that never arrived may well arrive next time, whereas a 400 fails identically however often it is
repeated.

## Wire shape

The ingest envelope is shared byte-for-byte across the server SDKs:

```
{"track": [{"name": "<event>", "payload": [{eventId, timestamp, profileId?, userId?, accountId?,
                                            data?, userAttributes?, accountAttributes?}]}]}
```

**An absent field is omitted, never sent as null** — a present key is an assertion about the entity.
A divergence here does not fail any test; it ingests cleanly and never appears in a report.

## Credentials

The evaluation endpoint requires a **server** credential, sent as HTTP **Basic** — not Bearer. A
public key holds users and accounts and nothing else, and the response describes how every
experience in the project targets, so a public key is refused there. Never log the credential and
never put it in a URL.

## Node specifics

- **TypeScript is the contract.** Omitting a field from an option type does not forbid it: excess-property
  checks fire only on fresh object literals, so a variable passed in still carries the extra key to the
  wire. Use `field?: never` to actually refuse one, and prove type-level rules with `@ts-expect-error`
  tests where an unused directive fails the build.
- **No bare `git push`, no floating dependency ranges in the published package.**
- `npm run verify:consumer` builds a consumer against the packed tarball. An export nothing imports has
  not shipped, and that job is what catches it.
