# Future Game Ideas

> **Document status (2026-07-25):** This is an unscheduled concept backlog, not an implementation
> roadmap. Voice Trivia is not playable.
>
> **Operational truth:** Use the [README](../README.md), [Deployment](DEPLOYMENT.md), and
> [Infrastructure Setup](INFRA_SETUP.md) for current games, behavior, and operations.

## Voice Trivia

**Status:** Unscheduled concept; not playable

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

## Twilio Games Station Platform

The product-direction roadmap and decision history for TAC, lead capture, digital coins, earning
challenges, a single-display queue, post-game summaries, Conversation Memory, and Conversation
Intelligence is preserved in the [Twilio Games station plan](TWILIO_ARCADE_PLAN.md). It is not the
current operational source of truth.
