# Phase 2 brief

Read docs/phase-1.md first. Add the league layer and the story director to colorwars. Save this brief to docs/phase-2.md.

## LEAGUE
- league/season.json holds: season number, episodes (id, event, seed, placements, MVP, date), standings (points, wins, podiums, current streaks), all-time records (fastest win, biggest comeback, longest losing streak) and head-to-head records.
- Points: 1st 10, 2nd 6, 3rd 3, 4th 1. Finale episodes count double.
- The standings leader is the crown team. The last-place team starts each episode with a one-time shield that absorbs its first hazard hit.
- Rendering never changes season.json. Only this does: python -m colorwars commit <episode_id> (run after actually posting).
- episode.yaml values now come from season.json automatically.

## STORYLINES
- Generate candidate lines from the stats: losing and winning streaks, rivalry records (Red vs Blue: 7-6 all time), crown pressure, first-ever wins, record chases.
- Score them by how extreme the stat is. Use the best as the hook line and generate the outro teaser, for example: Next: Disaster Drop. Can Green break the curse?

## NAMES QUEUE
- names.txt is a queue. Each name is used once, in the order received, on the team the viewer asked for, before any name repeats. Log used names in league/names_used.txt.

## STORY DIRECTOR (drama mining)
- python -m colorwars mine --event ring_of_doom --runs 500 --top 5 runs simulate() headless across seeds in parallel processes and scores every run.
- Drama score: lead changes x3, seconds the final two survived together (cap 10), near misses x1.5 (cap 8), +8 if the winner was in last place after 15 s, +3 if the crown team loses, -5 for any stretch over 9 s with no elimination, hazard or near miss, -5 if any team is wiped out before 15 s.
- Hard constraints: a valid finish and a final video length of 61 to 70 s after slow motion and the outro.
- Story flags: --winner green, --not-winner red, --comeback, --min-lead-changes 3, --photo-finish (final two together at least 6 s).
- Print the top seeds with their stats, write out/mine_<event>.csv, and add render --best to use the top seed.

## PACKAGING
For each render also write caption.txt (event, episode, hook line, MVP shoutout, hashtags #colorwars #simulation plus two event tags) and pinned_comment.txt (Comment your team and a name to get a ball in the next episode). Never use dashes in captions.

## DONE WHEN
mine finds at least 5 valid seeds out of 500 in under 5 minutes, render --best works, and after commit the next render shows the updated standings, crown and storyline.
