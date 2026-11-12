# Events batch 2 brief

Read docs/phase-1.md and docs/phase-2.md first. Add three events on the shared pipeline. Build and verify them one at a time, in this order. Save this brief to docs/events-batch-2.md.

## TURF WAR
- A 28x28 grid inside an 840x840 square. Each team starts with one quadrant in its color and one ball inside it.
- Balls move at constant speed. Hitting another team's cell converts it and bounces the ball off. Walls bounce.
- Every 8 s a power-up appears on a random cell: bomb (convert 3x3), ghost (pass through 3 cells), speed (x1.3 for 4 s).
- A team at zero cells is eliminated. After 58 s of sim time, rank by cell count. Show a live cell-count bar per team.

## GREAT ESCAPE
- Four balls start in the center inside 6 concentric rotating rings (radii 120 to 420), each with one 28 degree gap, alternating directions and speeds. Gravity 600.
- A ball passing through a gap shatters that ring for everyone, with a glass-burst effect.
- First ball out of the outermost ring wins; rank the rest by escape order.
- Each collision plays the next note of the season theme: a 32-note melody generated once per season from the pentatonic scale and saved in league/theme.json, so viewers start to recognize it across episodes.

## CHAMPION DUEL
- 1v1 in an 840x840 arena, no gravity, constant speed. Each champion has 100 HP and radius 60.
- Signature powers grow with every hit landed: Red gets 3 rotating spikes that lengthen, Blue a rotating shield arc that widens and blocks damage, Green spawns a mini twin (max 4) that deals 1 damage, Yellow gains 6% speed.
- HP bars and damage numbers. Slow motion on hits over 8 damage, and a replay of the final hit.
- python -m colorwars balance --runs 2000 runs every matchup and tunes the power numbers until no matchup wins more than 60%. Save the tuned numbers to teams.yaml.
- A bracket mode creates three episodes: two semifinals and a final.
