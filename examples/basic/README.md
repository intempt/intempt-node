# Basic sample app

Exercises every namespace of the Intempt Node SDK: identity, events, commerce,
consent, decisions, opt-out, and buffered mode.

It installs the SDK from a packed tarball rather than the source tree, so it
proves the published artifact works the way a customer would consume it.

## Run it offline

No credentials needed. The app starts a local mock API when `INTEMPT_API_KEY` is
unset.

```bash
# from the repository root
npm run verify:consumer
```

That builds, packs, installs the tarball here, typechecks against the shipped
`.d.ts`, and runs the app.

To iterate on the app alone, once the tarball is installed:

```bash
cd examples/basic
npm start
```

## Run it against a real environment

```bash
cd examples/basic
INTEMPT_HOST=api.staging.intempt.com \
INTEMPT_ORG=my-org \
INTEMPT_PROJECT=my-project \
INTEMPT_API_KEY=prefix.secret \
INTEMPT_SOURCE_ID=684508596718616576 \
INTEMPT_FEED_ID=848 \
npm start
```

This writes real events. Point it at a throwaway project.

## Why the typecheck is stricter than the library

`tsconfig.json` here sets `exactOptionalPropertyTypes: true` and
`skipLibCheck: false` — both stricter than the SDK's own build. A consumer with a
strict configuration should not hit errors inside our `.d.ts`, and this is where
that gets caught.
