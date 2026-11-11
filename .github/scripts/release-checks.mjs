// The merged pull request's CI as the release gate reads it: the check runs
// named `ci` (the job in .github/workflows/ci.yml that main requires) that
// GitHub Actions itself reported on the pull request's head. There must be one,
// and every one must have passed. The merge queue tests its own commit under
// the same name; this reads the head, which every merged pull request has.
const GITHUB_ACTIONS = 15368;
export const CI_CHECK = "ci";
export const ciPassed = (checkRuns) => {
  const runs = checkRuns.filter(
    (run) => run.name === CI_CHECK && run.app?.id === GITHUB_ACTIONS,
  );
  return runs.length > 0 && runs.every((run) => run.conclusion === "success");
};
