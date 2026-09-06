"""Databricks workflow entry point for the SOURCE_PROVIDED score promotion job."""

from ..load_pillar_input.load_pillar_input import load_pillar_input
from ..load_scorecard_input.load_scorecard_input import load_scorecard_input
from .promote_scores import promote_pillar_scores, promote_scorecard_scores


def main() -> None:
    pillar_inputs, _ = load_pillar_input()
    scorecard_inputs, _ = load_scorecard_input()

    pillar_scores = promote_pillar_scores(pillar_inputs)
    scorecard_scores = promote_scorecard_scores(scorecard_inputs)

    print(f"Promoted {len(pillar_scores)} PILLAR_SCORE records.")
    print(f"Promoted {len(scorecard_scores)} SCORECARD_SCORE records.")


if __name__ == "__main__":
    main()
