#!/bin/sh
# The ruleset of the default branch, from .github/rulesets/main.json (#35).
#
#   scripts/ruleset.sh                       create the ruleset, or update the one of the same name
#   scripts/ruleset.sh --check               end with 1 and name the differences when the repository differs from the file
#   scripts/ruleset.sh --check --from FILE   compare with FILE (the host's answer) instead of asking the host
#
# The owner runs it. A session never applies it.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
file="$here/../.github/rulesets/main.json"
mode=apply
from=

while [ $# -gt 0 ]; do
  case $1 in
    --check) mode=check ;;
    --from)
      [ $# -ge 2 ] || { echo "ruleset.sh: --from needs a file" >&2; exit 2; }
      from=$2
      shift
      ;;
    *) echo "usage: ruleset.sh [--check [--from FILE]]" >&2; exit 2 ;;
  esac
  shift
done

name=$(jq -r .name "$file")

# The id of the ruleset of that name at the host, or nothing.
host_id() {
  gh api "repos/{owner}/{repo}/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -n 1
}

if [ "$mode" = check ]; then
  if [ -n "$from" ]; then
    actual=$(cat "$from")
  else
    id=$(host_id)
    [ -n "$id" ] || { echo "ruleset.sh: no ruleset named $name at the host" >&2; exit 1; }
    actual=$(gh api "repos/{owner}/{repo}/rulesets/$id")
  fi
  # Every value the file holds must be the same at the host, and the lists must be as long.
  differences=$(jq -r --argjson actual "$actual" '
    def leaves: [paths(scalars)];
    def lists: [paths(type == "array")];
    ( [leaves[] as $p | select(getpath($p) != ($actual | getpath($p)))
        | "\($p | map(tostring) | join(".")): file \(getpath($p) | tojson), host \($actual | getpath($p) | tojson)"]
    + [lists[] as $p | select((getpath($p) | length) != (($actual | getpath($p)) | length))
        | "\($p | map(tostring) | join(".")): file has \(getpath($p) | length) items, host has \(($actual | getpath($p)) | length)"]
    ) | unique | .[]' "$file")
  if [ -n "$differences" ]; then
    echo "The ruleset at the host differs from $file:"
    echo "$differences"
    exit 1
  fi
  echo "The ruleset at the host is the one in $file."
  exit 0
fi

id=$(host_id)
if [ -n "$id" ]; then
  gh api --method PUT "repos/{owner}/{repo}/rulesets/$id" --input "$file" > /dev/null
  echo "Updated the ruleset $name."
else
  gh api --method POST "repos/{owner}/{repo}/rulesets" --input "$file" > /dev/null
  echo "Created the ruleset $name."
fi
