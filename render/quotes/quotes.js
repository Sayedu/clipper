"use strict";
/* ═══════════════════════════════════════════════════════════════
   THE REMINDER BANK — original, hard-hitting advice inspired by broad
   Quranic/Hadith themes (sabr, tawakkul, shukr, istighfar, sincerity,
   the akhirah...). NONE of these are literal ayahs or hadith text, and
   none are written as if God or the Prophet ﷺ is being directly quoted
   — that would risk misattribution/mistranslation. These are original
   lines of universal advice in a modern voice, the same way any writer
   might draw on a tradition's themes without claiming scriptural
   authority for their own words.

   Each entry is a two-beat "setup / punch" couplet — the reveal in
   game.js holds the setup, then lands the punch a beat later, which is
   what gives a silent, 15-second card its hit. `tag` is the small
   eyebrow label shown above the setup line.
   ═══════════════════════════════════════════════════════════════ */
window.QUOTE_BANK = [
  { tag: "PATIENCE",   setup: "The dua you've repeated for years",                          punch: "hasn't been ignored — it's being perfected." },
  { tag: "LETTING GO", setup: "Some people were never meant to stay.",                       punch: "They were removed to protect what's coming." },
  { tag: "TRUST",      setup: "You're not stuck. You're being redirected.",                  punch: "Trust the One writing the story." },
  { tag: "GRATITUDE",  setup: "Count what's still standing",                                 punch: "before you count what fell apart." },
  { tag: "HUMILITY",   setup: "The more a soul lowers itself before God,",                   punch: "the higher He raises it among people." },
  { tag: "FORGIVENESS",setup: "Holding a grudge is drinking poison",                         punch: "and waiting for someone else's heart to stop." },
  { tag: "DEATH",      setup: "You're not busy. You're distracted",                          punch: "from the one appointment you can't reschedule." },
  { tag: "SINCERITY",  setup: "Do the good deed no one will ever see.",                      punch: "That's the one that actually counts." },
  { tag: "HARDSHIP",   setup: "This trial isn't a punishment.",                              punch: "It's how the calluses of the soul get formed." },
  { tag: "THE TONGUE", setup: "Before you repeat what you heard,",                           punch: "ask if your tongue can carry that weight on Judgment Day." },
  { tag: "COMPARISON", setup: "Someone else's blessing was never meant for you.",             punch: "Comparing your path is how you miss your own." },
  { tag: "PRAYER",     setup: "Five times a day you're handed a reset button.",              punch: "Most people are just too busy to press it." },
  { tag: "PARENTS",    setup: "One day you'll call and no one will pick up.",                punch: "Call your mother today like it's the last time — because one day it will be." },
  { tag: "ANGER",      setup: "Anger is a test disguised as a right.",                       punch: "The strong aren't silent — they're just not owned by the moment." },
  { tag: "WEALTH",     setup: "You didn't bring money into this world crying.",              punch: "You won't leave it holding any either." },
  { tag: "REPENTANCE", setup: "Don't wait to feel worthy before you turn back.",             punch: "The turning back is what makes you worthy." },
  { tag: "TIME",       setup: "The days aren't passing.",                                    punch: "You are." },
  { tag: "TRIALS",     setup: "Nothing was ever meant to stay easy forever.",                punch: "The ease was the test. The hardship is the reminder." },
  { tag: "KINDNESS",   setup: "You will never regret the softness you showed someone struggling.", punch: "You will only regret choosing to be right instead of kind." },
  { tag: "DUA",        setup: "Every dua you've ever made is still alive somewhere.",        punch: "Nothing sincere is wasted — only delayed." },
  { tag: "THE HEART",  setup: "A hard heart isn't born.",                                    punch: "It's built, one ignored reminder at a time." },
  { tag: "CONTENTMENT",setup: "You keep chasing more",                                       punch: "because you never learned to sit still with enough." },
  { tag: "COMPARISON", setup: "You're grieving a life you only saw the highlight reel of.",  punch: "No one posts their sujood at 3am." },
  { tag: "ISTIGHFAR",  setup: "You don't need a clean slate to start over.",                 punch: "You need three words and a sincere heart: forgive me." },
  { tag: "FRIENDSHIP", setup: "Some friends bring you closer to God.",                       punch: "Others just bring you closer to regret." },
  { tag: "PATIENCE",   setup: "You want the answer today.",                                  punch: "God is preparing you for what the answer requires." },
  { tag: "HUMILITY",   setup: "The tallest trees bend the most in the storm.",               punch: "The ones that don't, break." },
  { tag: "LOSS",       setup: "What was taken from you",                                     punch: "was never going to fit the plan meant for you anyway." },
  { tag: "JUDGMENT",   setup: "You don't know what someone begged God for",                  punch: "before they got the thing you're jealous of." },
  { tag: "SILENCE",    setup: "Not every attack deserves a response.",                       punch: "Some things are best answered with silence and time." },
  { tag: "PURPOSE",    setup: "You keep planning for a future",                              punch: "you haven't even prayed to see." },
  { tag: "CHARACTER",  setup: "No one remembers how good you looked.",                       punch: "Everyone remembers how you made them feel." },
  { tag: "FEAR",       setup: "You're afraid of losing what you have.",                      punch: "Real peace is trusting the One who gave it to you." },
  { tag: "GRIEF",      setup: "Grief isn't a lack of faith.",                                punch: "It's love with nowhere left to go — give it to God instead." },
  { tag: "EFFORT",     setup: "You're not owed the outcome.",                                punch: "You're only owed the reward for trying sincerely." },
  { tag: "GOSSIP",     setup: "Repeating someone's secret",                                  punch: "says more about your character than theirs." },
  { tag: "SELF-WORTH", setup: "Stop auditioning for people who already decided to overlook you.", punch: "Not everyone was assigned to clap for your journey." },
  { tag: "PATIENCE",   setup: "You're not behind.",                                          punch: "You're exactly where your test requires you to be." },
  { tag: "RELIANCE",   setup: "You tied the camel and still couldn't sleep.",                punch: "Tie it — then actually let go of the rope." },
  { tag: "DEATH",      setup: "You keep saying 'tomorrow.'",                                 punch: "The grave doesn't care about your schedule." },
  { tag: "ENVY",       setup: "The house you're jealous of",                                 punch: "might be the loneliest one on the street." },
  { tag: "SABR",       setup: "Patience isn't doing nothing.",                               punch: "It's doing everything right while waiting on what you can't control." },
  { tag: "SHUKR",      setup: "You asked for exactly this, last year.",                      punch: "You're living in the answer right now and calling it ordinary." },
  { tag: "EGO",        setup: "You don't lose by walking away.",                             punch: "You lose by staying just to prove a point." },
  { tag: "TRUST",      setup: "Closed doors are still mercy.",                               punch: "You just can't see the room they're protecting you from." },
  { tag: "REFLECTION", setup: "One day this life will feel like a dream you woke up from.",  punch: "Live like you already know that." },
  { tag: "FORGIVENESS",setup: "Forgiving them doesn't mean it was okay.",                    punch: "It means you refuse to let it live in you rent-free." },
  { tag: "PURPOSE",    setup: "You weren't created to be comfortable.",                      punch: "You were created to be tested — and return better than you left." },
  { tag: "HOPE",       setup: "No matter how far you've drifted,",                           punch: "the door back is closer than your next breath." },
  { tag: "LEGACY",     setup: "You won't be remembered for what you owned.",                 punch: "You'll be remembered for who you helped, forgave, and loved well." },
];
