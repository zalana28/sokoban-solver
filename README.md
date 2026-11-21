# sokoban-solver

[![make.fun · sokoban-solver-01](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/zalana28/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/zalana28/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01)

A push-optimal Sokoban solver for the bounty "Build the best Sokoban
solver, 21 November 2026" (`sokoban-solver-01-run-20261121`).

- `main.ts` — the whole entry: reads every level under
  `/input/<id>/level.txt`, writes `/output/<id>/solution.txt`.

Approach: every drawn level is a hallway with 1–4 small rooms off it,
and a box pushed out of a room can never come back, so the rooms are
independent problems. The solver splits a level into its rooms (cutting
the dead squares of the hallway row), solves each room push-optimally
with A* over pushes — states are the boxes plus the player's reachable
region, the heuristic is the cheapest box-to-goal assignment by walking
distance, dead squares and frozen 2×2 blocks are pruned — and
concatenates the walks and pushes. A plain push-BFS with the same pruning
is the fallback when A* runs out of its work budget. No clock is read,
so two runs write the same bytes.

Practice set: **1,000,000 / 1,000,000** — all 5 instances solved in
exactly their push-optimal counts (13, 16, 29, 47, 60 pushes), in ~0.3 s
for the whole set. Also 1,000,000 on 10 freshly drawn sets (50 levels).
See `NOTES.md` for the approach, results and verification.

License: MIT.
