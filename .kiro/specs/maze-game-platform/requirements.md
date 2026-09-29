# Requirements Document

## Introduction

The Maze Game Platform (Phase 2) extends the single-player maze game (Phase 1) into a
multiplayer, account-based, score-tracking platform hosted on AWS. Players sign in with real
accounts, play mazes concurrently, and have their results persisted and ranked against other
players on a leaderboard. A later increment adds real-time shared sessions in which multiple
players race through the same maze simultaneously.

This document defines the functional requirements for Phase 2. It is partitioned into two
increments so the first can be built and shipped before the second begins:

- **Phase 2a — Concurrent players, accounts, persistent scores, and leaderboard.**
  Requirements 1–7.
- **Phase 2b — Real-time shared sessions.** Requirements 8–10.

Phase 2 builds on, and does not modify, the Phase 1 single-player core. The core game rules
(maze generation/validation, movement, timing, win/loss) remain pure and framework-agnostic;
platform capabilities are added as services and adapters around that core. This document
states *what* the platform must do; the AWS services, UI framework, and ranking mechanism
that satisfy these requirements are selected in the design phase (see `docs/aws-decisions.md`).

## Glossary

- **Platform**: The overall Phase 2 system — client, backend services, identity, and data
  stores — that provides accounts, persistent scores, leaderboards, and (in 2b) real-time
  shared sessions around the maze game.
- **Player**: A person interacting with the Platform.
- **Account**: A persistent, authenticated identity for a Player, created at sign-up and used
  to sign in. A score belongs to exactly one Account.
- **Credentials**: The secret(s) a Player uses to authenticate (e.g. password), managed by
  the identity service.
- **Session (auth)**: An authenticated period of Platform use following a successful sign-in,
  represented by a token with a bounded lifetime.
- **Run**: A single playthrough of a maze by a Player, from start until a win or loss
  outcome, as defined by the Phase 1 game rules.
- **Score**: The persisted record of a completed Run tied to an Account, including at least
  the completion time and the maze parameters (e.g. size/difficulty) it was achieved under.
- **Personal_Best**: The best (lowest completion time) Score an Account has achieved for a
  given maze parameter set.
- **Leaderboard**: A ranking of Scores across Accounts for a given maze parameter set,
  ordered by completion time.
- **Rank**: The position of a Score or Account within a Leaderboard.
- **Shared_Session** (2b): A real-time game instance in which multiple Players race through
  the same maze concurrently, with live updates of each participant's progress.
- **Participant** (2b): A Player who has joined a Shared_Session.
- **Authoritative_State** (2b): The server-held source of truth for a Shared_Session's maze,
  participant positions, timing, and outcomes.

## Requirements — Phase 2a

### Requirement 1: Create an Account

**User Story:** As a Player, I want to create an account, so that my scores are saved and
tied to me.

#### Acceptance Criteria

1. WHEN a Player submits a sign-up request with a valid identifier and Credentials that meet
   the Platform's stated Credential policy, THE Platform SHALL create exactly one Account for
   that identifier and confirm creation to the Player.
2. IF a Player submits a sign-up request with an identifier that already belongs to an
   existing Account, THEN THE Platform SHALL NOT create a second Account and SHALL indicate
   that the identifier is already registered.
3. IF a Player submits Credentials that do not meet the stated Credential policy, THEN THE
   Platform SHALL reject the sign-up, create no Account, and indicate which policy
   requirement was not met.
4. THE Platform SHALL store Credentials only in a form that is not reversible to the original
   secret (i.e. never store plaintext Credentials).
5. WHERE the Platform requires identifier verification (e.g. email confirmation), THE
   Platform SHALL withhold sign-in until the identifier is verified and SHALL provide a means
   to complete verification.

### Requirement 2: Sign In and Sign Out

**User Story:** As a Player, I want to sign in and out, so that only I can act as my account
and I can end my session securely.

#### Acceptance Criteria

1. WHEN a Player submits valid Credentials for a verified Account, THE Platform SHALL
   establish an authenticated Session and return a token with a bounded lifetime.
2. IF a Player submits invalid Credentials, THEN THE Platform SHALL NOT establish a Session
   and SHALL indicate that authentication failed, without revealing which factor was
   incorrect.
3. WHEN a Player signs out, THE Platform SHALL end the authenticated Session such that the
   prior token can no longer be used to act as the Account.
4. WHEN an authenticated Session's token reaches the end of its lifetime, THE Platform SHALL
   reject further authenticated actions using that token until the Player re-authenticates or
   the Session is refreshed by the Platform's stated mechanism.
5. THE Platform SHALL limit repeated failed sign-in attempts for an identifier to reduce
   automated credential-guessing, per a stated threshold.

### Requirement 3: Recover Account Access

**User Story:** As a Player, I want to recover access if I forget my credentials, so that I do
not lose my account and scores.

#### Acceptance Criteria

1. WHEN a Player initiates account recovery for a registered, verified identifier, THE
   Platform SHALL send a recovery mechanism to that identifier through a channel the Account
   owner controls.
2. WHEN a Player completes the recovery mechanism within its validity window, THE Platform
   SHALL allow the Player to set new Credentials and SHALL invalidate the recovery mechanism
   after use.
3. IF a recovery mechanism is used after its validity window, THEN THE Platform SHALL reject
   it and require the Player to initiate recovery again.
4. IF account recovery is initiated for an identifier that is not registered, THEN THE
   Platform SHALL NOT reveal whether the identifier exists.

### Requirement 4: Persist a Score

**User Story:** As a signed-in Player, I want my completed runs to be saved, so that my
achievements are remembered across sessions and devices.

#### Acceptance Criteria

1. WHEN an authenticated Player completes a Run with a win outcome, THE Platform SHALL persist
   a Score tied to the Player's Account that records at least the completion time and the maze
   parameters of the Run.
2. THE Platform SHALL retain a persisted Score until the owning Account is deleted or the
   Player deletes the Score, and SHALL make it available to the same Account on any device
   after re-authentication.
3. IF a Score submission is received without a valid authenticated Session, THEN THE Platform
   SHALL reject the submission and persist nothing.
4. IF a Score submission is malformed or reports values outside the Platform's accepted ranges
   (e.g. a non-positive time or unknown maze parameters), THEN THE Platform SHALL reject the
   submission, persist nothing, and indicate the submission was invalid.
5. WHEN a Player completes a Run whose completion time is better than the Player's existing
   Personal_Best for the same maze parameters, THE Platform SHALL update the Personal_Best for
   that Account and maze parameter set.
6. THE Platform SHALL treat a Score's completion time as authoritative only when it is
   consistent with the Platform's server-side validation of the Run, so that a client cannot
   persist an arbitrary unearned time.

### Requirement 5: View Personal Scores and History

**User Story:** As a signed-in Player, I want to see my own scores and best times, so that I
can track my progress.

#### Acceptance Criteria

1. WHEN an authenticated Player requests their score history, THE Platform SHALL return the
   Scores belonging to that Account, and no Scores belonging to any other Account.
2. WHEN an authenticated Player requests their Personal_Best for a maze parameter set, THE
   Platform SHALL return the lowest completion time that Account has recorded for that
   parameter set, or indicate that none exists.
3. WHILE a Player is not authenticated, THE Platform SHALL NOT disclose any Account's private
   score history.

### Requirement 6: View the Leaderboard

**User Story:** As a Player, I want to see how my times compare to others, so that I am
motivated to compete.

#### Acceptance Criteria

1. WHEN a Player requests the Leaderboard for a maze parameter set, THE Platform SHALL return
   Scores across Accounts ranked by completion time in ascending order (fastest first).
2. THE Platform SHALL present each Leaderboard entry with a Player-chosen display name rather
   than the Player's private identifier (e.g. email).
3. WHEN an authenticated Player requests their own Rank for a maze parameter set, THE Platform
   SHALL return that Player's current position within the Leaderboard for that parameter set,
   or indicate the Player is unranked.
4. THE Platform SHALL return the top segment of a Leaderboard within a stated response-time
   budget under the expected concurrent load.
5. WHEN a newly persisted Score qualifies for the Leaderboard, THE Platform SHALL reflect it
   in subsequent Leaderboard reads within a stated freshness bound.

### Requirement 7: Play Concurrently

**User Story:** As one of many players, I want to play at the same time as others without
interference, so that the platform supports a real audience.

#### Acceptance Criteria

1. WHILE multiple authenticated Players are each playing their own Runs at the same time, THE
   Platform SHALL keep each Player's game state and Scores isolated so that one Player's
   actions never alter another Player's Run or Scores.
2. THE Platform SHALL sustain the stated number of concurrent Players performing Runs and
   Score submissions while meeting the Leaderboard and Score-submission response-time budgets.
3. IF platform capacity is exceeded, THEN THE Platform SHALL degrade gracefully — rejecting or
   deferring new work with a clear indication — rather than corrupting or losing already
   accepted Scores.
4. WHEN two Score submissions for the same Account are processed concurrently, THE Platform
   SHALL persist a consistent result without losing an otherwise-valid Score.

## Requirements — Phase 2b

### Requirement 8: Join a Shared Session

**User Story:** As a Player, I want to join a live race with others in the same maze, so that
I can compete head-to-head in real time.

#### Acceptance Criteria

1. WHEN an authenticated Player joins a Shared_Session, THE Platform SHALL place the Player as
   a Participant into a session whose maze is identical for all Participants.
2. WHEN a Shared_Session begins, THE Platform SHALL start all Participants from the same start
   cell under the same time limit.
3. IF a Player attempts to join a Shared_Session that has already ended or is full per a stated
   capacity, THEN THE Platform SHALL NOT add the Player and SHALL indicate why.
4. WHILE a Player is not authenticated, THE Platform SHALL NOT allow the Player to join a
   Shared_Session.

### Requirement 9: Real-Time Progress Updates

**User Story:** As a Participant, I want to see others' progress live, so that the race feels
immediate and competitive.

#### Acceptance Criteria

1. WHILE a Shared_Session is active, THE Platform SHALL propagate each Participant's progress
   updates to the other Participants within a stated latency budget.
2. THE Platform SHALL maintain the Authoritative_State for a Shared_Session on the server, and
   SHALL resolve each Participant's moves against that Authoritative_State rather than trusting
   client-reported positions.
3. IF a Participant's client sends a move that conflicts with the Authoritative_State (e.g. a
   move into a wall or an out-of-order update), THEN THE Platform SHALL reject that move and
   keep the Participant's authoritative position unchanged.
4. WHEN a Participant disconnects during a Shared_Session, THE Platform SHALL continue the
   Shared_Session for the remaining Participants and SHALL reflect the disconnection to them.
5. WHERE a disconnected Participant reconnects before the Shared_Session ends, THE Platform
   SHALL restore that Participant to the current Authoritative_State.

### Requirement 10: Resolve and Record a Shared Session

**User Story:** As a Participant, I want the race result to be decided fairly and recorded, so
that winning a live race counts.

#### Acceptance Criteria

1. WHEN a Participant reaches the exit before the time limit while the Shared_Session is
   active, THE Platform SHALL record that Participant's finishing time and Rank within the
   Shared_Session from the Authoritative_State.
2. WHEN a Shared_Session ends, THE Platform SHALL report the final ordering of Participants to
   all connected Participants within a stated time budget.
3. WHEN a Participant achieves a qualifying result in a Shared_Session, THE Platform SHALL
   persist a Score for that Participant's Account consistent with Requirement 4, so that
   Shared_Session results feed the same persistent-score and Leaderboard system.
4. IF the Shared_Session's time limit expires before a Participant reaches the exit, THEN THE
   Platform SHALL record that Participant as not having finished, with no win Score persisted.

## Cross-Cutting Requirements

### Requirement 11: Security and Privacy of Accounts and Data

**User Story:** As a Player, I want my personal data protected, so that I can trust the
platform with a real account.

#### Acceptance Criteria

1. THE Platform SHALL transmit Credentials, tokens, and personal data only over encrypted
   channels.
2. THE Platform SHALL restrict each authenticated action to the data owned by the acting
   Account, except for data explicitly designated public (e.g. Leaderboard display names and
   times).
3. THE Platform SHALL NOT expose a Player's private identifier (e.g. email) to other Players.
4. WHEN the Platform logs activity, THE Platform SHALL NOT record Credentials or full token
   values.
5. WHEN a Player requests deletion of their Account, THE Platform SHALL delete or irreversibly
   anonymize the Account's personal data and private Scores per the Platform's stated data
   policy.

### Requirement 12: Modern, Responsive, Accessible UI

**User Story:** As a Player, I want a modern and responsive interface, so that the game is
pleasant to use on my device.

#### Acceptance Criteria

1. THE Platform's client SHALL present a responsive layout usable on common desktop and mobile
   viewport sizes without loss of function.
2. WHILE a Run is in progress, THE client SHALL render gameplay fluidly, keeping avatar
   movement and timer updates visually smooth under the stated performance target.
3. THE client SHALL provide clear feedback for authentication state, Run outcomes, Score
   submission results, and Leaderboard position.
4. THE client SHALL meet the Platform's stated accessibility criteria for keyboard operability
   and perceivable feedback, consistent with the accessibility guidance in the engineering
   standards.
5. WHEN a network or backend operation fails, THE client SHALL indicate the failure to the
   Player and SHALL NOT leave the interface in an ambiguous or frozen state.
