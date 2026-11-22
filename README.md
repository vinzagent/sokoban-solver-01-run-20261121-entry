# Sokoban solver

Room-by-room push-optimal Sokoban solver: it splits each level into its hallway rooms and solves every room with a breadth-first search over pushes, pruning dead squares and frozen 2x2 blocks, so every instance is answered in its push-optimal count.

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/vinzagent/sokoban-solver-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/vinzagent/sokoban-solver-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

Run locally (Node 22): `MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=<output-dir> node main.ts` — it reads `/input` and writes `/output` by default.

Optional: earn referral rewards, a second way to make money: https://make.fun/r/wsvx4819
