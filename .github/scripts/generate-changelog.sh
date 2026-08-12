#!/bin/bash
# Builds release notes for a tag from the commit range since the previous tag.
# Conventional Commit prefixes are enforced by pr-title-check.yml, so the log is
# a reliable source and the notes do not have to be typed by hand.
set -euo pipefail

VERSION_LABEL="${1:?usage: generate-changelog.sh <version-label> <repo-url> [end-ref]}"
REPO_URL="${2:?usage: generate-changelog.sh <version-label> <repo-url> [end-ref]}"
END_REF="${3:-HEAD}"

PREVIOUS_TAG="$(git tag --sort=-creatordate --list 'v*' | grep -v "^${VERSION_LABEL}$" | head -1 || true)"

if [ -z "$PREVIOUS_TAG" ]; then
  RANGE="$END_REF"
  echo "## ${VERSION_LABEL}"
else
  RANGE="${PREVIOUS_TAG}..${END_REF}"
  echo "## ${VERSION_LABEL}"
  echo
  echo "Changes since ${PREVIOUS_TAG}."
fi
echo

emit_section() {
  local heading="$1" pattern="$2" body
  body="$(git log "$RANGE" --no-merges --format='%s|%h' | grep -E "$pattern" || true)"
  [ -z "$body" ] && return 0
  echo "### ${heading}"
  echo
  while IFS='|' read -r subject sha; do
    [ -z "$subject" ] && continue
    printf -- '- %s ([%s](%s/commit/%s))\n' \
      "$(echo "$subject" | sed -E 's/^[a-z]+(\([a-z0-9-]+\))?!?: //')" \
      "$sha" "$REPO_URL" "$sha"
  done <<< "$body"
  echo
}

BREAKING="$(git log "$RANGE" --no-merges --format='%s|%h' | grep -E '^[a-z]+(\([a-z0-9-]+\))?!: ' || true)"
if [ -n "$BREAKING" ]; then
  echo "### Breaking changes"
  echo
  while IFS='|' read -r subject sha; do
    [ -z "$subject" ] && continue
    printf -- '- %s ([%s](%s/commit/%s))\n' \
      "$(echo "$subject" | sed -E 's/^[a-z]+(\([a-z0-9-]+\))?!?: //')" \
      "$sha" "$REPO_URL" "$sha"
  done <<< "$BREAKING"
  echo
fi

emit_section 'Features' '^feat(\([a-z0-9-]+\))?: '
emit_section 'Fixes' '^fix(\([a-z0-9-]+\))?: '
emit_section 'Maintenance' '^(chore|ci|refactor|perf|test|docs)(\([a-z0-9-]+\))?: '

echo "**Full changelog**: ${REPO_URL}/blob/${VERSION_LABEL}/CHANGELOG.md"
