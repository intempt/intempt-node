# Conventions

**The cross-SDK surface is not decided here.** Every Intempt SDK conforms to
`intempt-swift/docs/SDK-API-CONTRACT.md`, which is the single authority on method names, argument
order, defaults and what is deliberately withheld. This file covers what is specific to Node and TypeScript and
to this repo. Where the two disagree, the contract wins and this file is the bug.

> **Pending contract revision: `intempt-swift` [#8](https://github.com/intempt/intempt-swift/pull/8), still open.**
> The contract as it stands on `intempt-swift` `main` carries a section headed _"`experiments()` is
> deliberately NOT in any SDK"_, whose action table tells `node` / `python` / `php` they _must not
> be written with it_. #8 is the change that supersedes that decision and permits the `variation()`
> surface described here; it must land before or with this PR. (An earlier revision, #7, is
> **closed** — folded into #8 — so any reference to #7 is stale.) Until #8 merges, a reader who
> follows the citation above reaches a document that contradicts this file; that is the ordering,
> not a disagreement about the surface.

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
- **On a request path, every read names its keys. `allFlags()` exists, and it is a hazard.** On this
  endpoint an evaluation _is_ an exposure: `POST /optimization/choose-api` publishes a Kafka event
  per experience it evaluates, and omitting `names` makes it evaluate every experience the person is
  eligible for. So a read-everything call marks one person exposed to every running server
  experiment in the project — inflating each denominator uniformly, which shows up as an experiment
  that stopped detecting rather than one that broke — and, for a `once` display, spends their
  display budget on keys nobody rendered, after which `variation()` on those keys returns the
  caller's default permanently. The request has no exposure-suppression field, so **this cannot be
  fixed here**; it becomes safe when the platform can evaluate without publishing — an
  `exposure: false` on the choose request, or a separate non-recording route.

  `allFlags()` is nevertheless part of this SDK's surface, by ruling (Beso, 2026-09-01): php,
  python, swift, java and reactnative all ship it, and a method that exists in five SDKs and not the
  sixth is its own defect — a customer switching languages should not find the surface changed
  underneath them. It is documented as a hazard rather than withheld. **Use it to enumerate — a
  debug endpoint, an admin view, a one-off audit. Two keys on a request path is two `variation()`
  calls, not one `allFlags()`.**

- **`profileId` outranks `userId`, and callers must be told so.** The platform resolves a PROFILE
  entity keyed on `profileId` whenever it is non-blank and only falls through to `userId` when it is
  not, so passing both means assignment is device-scoped and `userId` is ignored. Pass one
  identifier and hold it constant; the sample models exactly one.
- **`sessionId` is what makes `once_per_visit` per-visit.** Unset, the platform stores the literal
  `"default"`, which never differs from itself — so the experience serves once and never again, and
  every exposure event is stamped `"default"`. A caller with no session concept may leave it unset,
  in which case `once_per_visit` degrades to `once` on this channel. That is a choice to make
  knowingly, not a default to inherit.
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
