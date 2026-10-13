"""review-gate decision: the commit status the review-gate workflow posts.

Takes on stdin {"pr_labels": [[name, ...], ...], "check_runs": [GitHub check-run object, ...]},
one label list per open PR whose head is the sha.
Prints {"state": "success" | "failure" | "pending", "description": str} and exits 0.
Exits 2 with a message on stderr, and prints nothing on stdout, when the input is not
that shape.
"""

import json
import sys

SKIP_LABELS = ("data-only", "snapshot", "macroscope-ignore")
MACROSCOPE_CHECK = "Macroscope - Correctness Check"
MACROSCOPE_APP_ID = 900172
PASSING = ("success", "neutral", "skipped")


class BadInput(Exception):
    pass


def skip_label(labels):
    return next((label for label in SKIP_LABELS if label in labels), None)


def decide(pr_labels, check_runs):
    skips = [skip_label(labels) for labels in pr_labels]
    if skips and None not in skips:
        return "success", f"skip label {skips[0]}: Macroscope does not review this PR"
    runs = [
        r for r in check_runs
        if r.get("name") == MACROSCOPE_CHECK
        and (r.get("app") or {}).get("id") == MACROSCOPE_APP_ID
    ]
    if not runs:
        return "pending", f"waiting for {MACROSCOPE_CHECK}"
    latest = max(runs, key=lambda r: r.get("id") or 0)
    if latest.get("status") != "completed":
        return "pending", f"{MACROSCOPE_CHECK} is {latest.get('status')}"
    conclusion = latest.get("conclusion")
    if conclusion in PASSING:
        return "success", f"{MACROSCOPE_CHECK}: {conclusion}"
    return "failure", f"{MACROSCOPE_CHECK}: {conclusion}"


def read_input(text):
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        raise BadInput(f"input is not JSON: {e}") from e
    if not isinstance(doc, dict):
        raise BadInput("input is not a JSON object")
    pr_labels, check_runs = doc.get("pr_labels"), doc.get("check_runs")
    if not isinstance(pr_labels, list) or not all(
        isinstance(labels, list) and all(isinstance(x, str) for x in labels) for labels in pr_labels
    ):
        raise BadInput(".pr_labels is not a list of label-name lists")
    if not isinstance(check_runs, list) or not all(isinstance(x, dict) for x in check_runs):
        raise BadInput(".check_runs is not a list of check-run objects")
    for run in check_runs:
        if not isinstance(run.get("app"), dict | None):
            raise BadInput("a check run's .app is not an object")
        if run.get("id") is not None and type(run["id"]) is not int:
            raise BadInput("a check run's .id is not an integer")
    return pr_labels, check_runs


def main():
    try:
        pr_labels, check_runs = read_input(sys.stdin.read())
    except BadInput as e:
        print(f"review_gate_decide: {e}", file=sys.stderr)
        return 2
    state, description = decide(pr_labels, check_runs)
    print(json.dumps({"state": state, "description": description[:140]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
