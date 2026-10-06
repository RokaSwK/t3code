set -euo pipefail
nightly=$(gh release list --repo pingdotgg/t3code --exclude-drafts --limit 40 --json tagName --jq '[.[] | select(.tagName | test("-nightly\\."))][0].tagName')
test -n "$nightly" && test "$nightly" != null
echo "UPSTREAM_NIGHTLY=$nightly" >> "$GITHUB_ENV"
if git merge-base --is-ancestor "refs/upstream/tags/$nightly" HEAD; then
  echo "personal already contains $nightly"
  exit 0
fi
git config user.name "fork-sync[bot]"
git config user.email "fork-sync@users.noreply.github.com"
if ! git merge --no-edit -m "chore(fork): merge upstream $nightly into personal" "refs/upstream/tags/$nightly"; then
  conflicts=$(git diff --name-only --diff-filter=U)
  git merge --abort
  printf '### Nightly merge blocked\n\n%s\n\n```\n%s\n```\n' "$nightly" "$conflicts" >> "$GITHUB_STEP_SUMMARY"
  echo "::error::Personal cannot publish until the $nightly merge conflicts are resolved."
  exit 1
fi
vp i
(cd apps/desktop && npx tsc --noEmit)
(cd apps/server && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
echo "MERGED_NIGHTLY=$nightly" >> "$GITHUB_ENV"
