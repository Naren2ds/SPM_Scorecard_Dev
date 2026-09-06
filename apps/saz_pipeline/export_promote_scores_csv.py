"""
Temporary export script (NOT part of the pipeline codebase).
Runs the SAZ pillar/scorecard input loaders, promotes them into PILLAR_SCORE and
SCORECARD_SCORE via the promotion job, and exports results via export_utils.
Delete after promotion job review is complete.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from export_utils import export_records

from data_pipeline.saz.load_pillar_input.load_pillar_input import load_pillar_input
from data_pipeline.saz.load_scorecard_input.load_scorecard_input import load_scorecard_input
from data_pipeline.saz.promote_scores.promote_scores import (
    promote_pillar_scores,
    promote_scorecard_scores,
)


def main() -> None:
    pillar_inputs, _ = load_pillar_input()
    scorecard_inputs, _ = load_scorecard_input()

    pillar_scores = promote_pillar_scores(pillar_inputs)
    scorecard_scores = promote_scorecard_scores(scorecard_inputs)

    export_records("pillar_score", pillar_scores, [])
    export_records("scorecard_score", scorecard_scores, [])


if __name__ == "__main__":
    main()
