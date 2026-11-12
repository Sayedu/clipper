# Disaster Drop brief

Read docs/phase-1.md and docs/phase-2.md first. Add a new event, disaster_drop: a vertical obstacle race. Save this brief to docs/event-disaster-drop.md.

## COURSE
- Playfield 840 px wide (x 120 to 960) and 10000 to 14000 px tall, built from seeded modules stacked top to bottom: peg field, zigzag ramps, spinner gauntlet, funnel, trapdoor floor, bumper maze, split paths that rejoin.
- Validate every course headless and reject seeds where any module traps a ball for more than 3 s even with the anti-stuck nudge.

## RACE
- 12 balls, 3 per team, with names and team traits. Same physics quality rules as phase 1.
- The camera follows the leading ball with smoothing and zooms out (down to 0.6x) to keep the last ball visible when the pack spreads.
- The Crusher: a spiked bar descending from the top and accelerating over time. Any ball it touches is eliminated.
- Disasters every 6 to 9 s, announced by a 1 s card such as LIGHTNING: YELLOW. Types: lightning (freeze one ball 1.2 s), hammer (a bar swings across a lane), wall (temporary blocker), boost (downward kick), gravity flip (1.5 s upward), magnet (pulls one color back). Target the crown team with double weight and the race leader with 1.5x weight.
- First ball across the finish line wins. Rank teams by their best ball. End 3 s after the 4th team's best ball finishes or is eliminated.

## LENGTH
The miner may change the number of modules so the final video lands between 61 and 70 s.

## DRAMA SCORE ADDITIONS
Lead changes between teams, a small winning margin, a disaster hitting the leader in the last 15 s, and how close the crusher got to the last ball.
