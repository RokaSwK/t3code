# Reporting must never stop other tracks or hide the original merge/check failure.
report() {
  local branch=$1 tag=$2 reason=$3 detail=$4
  local title="Upstream merge needs attention: $branch ← $tag"
  echo "::warning::$title: $reason"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### %s\n\n%s\n\n```\n%s\n```\n' "$title" "$reason" "$detail" >> "$GITHUB_STEP_SUMMARY" || true
  fi
  local issues_enabled existing
  issues_enabled=$(gh api "repos/$GH_REPO" --jq '.has_issues' 2>/dev/null) || issues_enabled=false
  if [ "$issues_enabled" != true ]; then
    echo "::warning::Issue reporting is unavailable; see this job's summary for the failure."
    return 0
  fi
  existing=$(gh issue list --state open --search "in:title \"$title\"" --json number --jq '.[0].number' 2>/dev/null) || return 0
  if [ -z "$existing" ]; then
    printf '%s\n\n```\n%s\n```\n\nRun: %s/%s/actions/runs/%s\n' "$reason" "$detail" "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID" |
      gh issue create --title "$title" --body-file - >/dev/null ||
      echo "::warning::Could not create the upstream-sync issue; see this job's summary."
  fi
  return 0
}
