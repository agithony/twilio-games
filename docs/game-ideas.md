# Future Game Ideas

## Voice Trivia

**Status:** Coming soon

A Kahoot-style multiplayer trivia game played entirely through Twilio Voice. Players call the
same game and watch questions appear on a shared display. They answer aloud over the phone, and
the first player to give the correct answer earns points. The game continues through a series of
questions and ends with a ranked scoreboard.

Core loop:

1. Players call in and join the same trivia session.
2. A question appears on the shared screen and is announced to callers.
3. Players answer by voice through the call.
4. The first correctly recognized answer increases that player's score.
5. The display reveals the answer, updates the leaderboard, and advances to the next question.

Future design decisions include answer-matching tolerance, simultaneous-answer tie handling,
question categories and difficulty, round length, and whether incorrect answers lock a player out
for the rest of the question.

## Twilio Arcade Platform

The approved plan to evolve this repository into Twilio Arcade, including TAC, lead capture, digital
coins, earning challenges, a smart single-display queue, post-game summaries, Conversation Memory,
and Conversation Intelligence, is the canonical [Twilio Arcade plan](TWILIO_ARCADE_PLAN.md).
