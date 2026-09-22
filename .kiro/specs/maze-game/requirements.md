# Requirements Document

## Introduction

The Maze Game is a single-player game in which a player navigates an avatar through a maze from a defined start position to a defined exit position. The player must reach the exit before a countdown timer expires. The game generates or displays a maze, renders the player's current position, accepts directional movement input, enforces wall collisions, tracks elapsed time against a time limit, and reports a win or loss outcome. This document defines the functional requirements for a first playable version of the feature.

## Glossary

- **Maze_Game**: The overall system that manages maze display, player movement, timing, and win/loss outcomes.
- **Maze**: A grid composed of cells, where each cell is either a passable path or an impassable wall. A Maze contains exactly one start cell and exactly one exit cell.
- **Cell**: A single position in the Maze grid, identified by row and column coordinates.
- **Wall**: A Cell that the Player cannot occupy.
- **Path**: A Cell that the Player can occupy.
- **Start_Cell**: The Path Cell where the Player avatar is positioned when a game begins.
- **Exit_Cell**: The Path Cell the Player must reach to win the game.
- **Player**: The person interacting with the Maze_Game.
- **Avatar**: The visual marker representing the Player's current Cell within the Maze.
- **Movement_Controller**: The Maze_Game component that processes directional input and updates the Avatar position.
- **Timer**: The Maze_Game component that counts down from the configured time limit to zero.
- **Time_Limit**: The configured duration, in seconds, within which the Player must reach the Exit_Cell.
- **Game_Session**: A single playthrough, from game start until a win or loss outcome is reached.

## Requirements

### Requirement 1: Display the Maze

**User Story:** As a Player, I want to see the maze on screen, so that I can plan a route from the start to the exit.

#### Acceptance Criteria

1. WHEN a Game_Session begins, THE Maze_Game SHALL render the Maze as a rectangular grid of Cells within 2 seconds, displaying each Cell as a distinct region with Path Cells and Wall Cells rendered in two visually different, non-identical appearances.
2. WHEN a Game_Session begins, THE Maze_Game SHALL render the Avatar positioned within the Start_Cell such that the Avatar overlaps the Start_Cell region and no other Cell.
3. WHEN a Game_Session begins, THE Maze_Game SHALL render a visual marker positioned within the Exit_Cell such that the marker overlaps the Exit_Cell region and no other Cell, and the marker is visually distinct from the Avatar and from Path and Wall Cells.
4. THE Maze_Game SHALL render a Maze that contains exactly one Start_Cell and exactly one Exit_Cell, where the Start_Cell and Exit_Cell are two different Cells.
5. THE Maze_Game SHALL render a Maze in which at least one sequence of horizontally or vertically adjacent Path Cells connects the Start_Cell to the Exit_Cell.
6. IF the Maze to be rendered contains zero or more than one Start_Cell, zero or more than one Exit_Cell, or no sequence of adjacent Path Cells connecting the Start_Cell to the Exit_Cell, THEN THE Maze_Game SHALL NOT begin the Game_Session and SHALL display an indication that the Maze is invalid.

### Requirement 2: Move the Avatar

**User Story:** As a Player, I want to move my avatar in four directions, so that I can navigate through the maze.

#### Acceptance Criteria

1. WHEN the Player issues an up, down, left, or right movement command AND the target Cell is within the Maze grid boundaries and is a Path Cell, THE Movement_Controller SHALL move the Avatar exactly one Cell in the corresponding direction within 100 milliseconds of receiving the command.
2. IF the target Cell of a movement command is a Wall, THEN THE Movement_Controller SHALL keep the Avatar at the current Cell and produce an indication that the movement was blocked.
3. IF the target Cell of a movement command is outside the Maze grid boundaries, THEN THE Movement_Controller SHALL keep the Avatar at the current Cell and produce an indication that the movement was blocked.
4. WHEN the Movement_Controller moves the Avatar to a new Cell, THE Maze_Game SHALL update the rendered Avatar position to the new Cell within 100 milliseconds of the move completing.
5. IF the Movement_Controller receives a movement command while a previous movement command for the Avatar is still in progress, THEN THE Movement_Controller SHALL ignore the new command until the previous movement completes.

### Requirement 3: Enforce the Time Limit

**User Story:** As a Player, I want a countdown timer, so that I am challenged to reach the exit quickly.

#### Acceptance Criteria

1. WHEN a Game_Session begins, THE Timer SHALL start counting down from the Time_Limit toward zero, where the Time_Limit is a configurable value between 30 and 600 seconds inclusive.
2. WHILE a Game_Session is active, THE Maze_Game SHALL display the remaining time as a non-negative integer number of seconds, updated at least once per second.
3. WHEN the Timer reaches zero before the Avatar occupies the Exit_Cell, THE Maze_Game SHALL end the Game_Session with a loss outcome and display an indication that the loss was caused by time expiration.
4. WHEN the Maze_Game ends the Game_Session, THE Timer SHALL stop counting down within 1 second and retain the remaining time value at the moment the Game_Session ended.
5. IF the Avatar occupies the Exit_Cell before the Timer reaches zero, THEN THE Maze_Game SHALL end the Game_Session with a win outcome and stop the Timer within 1 second.

### Requirement 4: Win by Reaching the Exit

**User Story:** As a Player, I want the game to recognize when I reach the exit, so that I know I have won.

#### Acceptance Criteria

1. WHEN the Movement_Controller moves the Avatar onto the Exit_Cell WHILE the Timer holds a value greater than 0 seconds, THE Maze_Game SHALL end the Game_Session with a win outcome within 500 milliseconds of the Avatar entering the Exit_Cell.
2. WHEN the Maze_Game ends the Game_Session with a win outcome, THE Maze_Game SHALL display the elapsed time from Game_Session start to Exit_Cell arrival, expressed in seconds with a resolution of 0.01 seconds.
3. WHEN the Maze_Game ends the Game_Session with a win outcome, THE Maze_Game SHALL display a visible win indication that distinguishes the win outcome from any other Game_Session end outcome.
4. WHILE a Game_Session has ended, THE Movement_Controller SHALL reject every movement command received and SHALL leave the Avatar position unchanged until a new Game_Session begins.
5. IF the Movement_Controller moves the Avatar onto the Exit_Cell WHILE the Timer holds a value of 0 seconds or less, THEN THE Maze_Game SHALL NOT end the Game_Session with a win outcome and SHALL retain the elapsed-time value at the moment the Timer reached 0 seconds.

### Requirement 5: Report the Outcome

**User Story:** As a Player, I want to see whether I won or lost, so that I understand the result of my attempt.

#### Acceptance Criteria

1. WHEN the Maze_Game ends the Game_Session with a win outcome, THE Maze_Game SHALL display a result message indicating a win within 1 second of the Game_Session ending.
2. WHEN the Maze_Game ends the Game_Session with a loss outcome, THE Maze_Game SHALL display a result message indicating a loss within 1 second of the Game_Session ending.
3. WHILE a result message is displayed, THE Maze_Game SHALL keep the result message visible until the Player activates the new-session control.
4. WHEN the Maze_Game displays a result message, THE Maze_Game SHALL present a single control, labeled to indicate starting a new attempt, that starts a new Game_Session.
5. WHEN the Player activates the new-session control, THE Maze_Game SHALL start a new Game_Session and remove the result message from display.

### Requirement 6: Start a New Game Session

**User Story:** As a Player, I want to start a new game, so that I can play again after finishing an attempt.

#### Acceptance Criteria

1. WHEN the Player activates the start control, THE Maze_Game SHALL begin a new Game_Session within 500 milliseconds of the activation.
2. WHEN a new Game_Session begins, THE Maze_Game SHALL reset the Avatar to the Start_Cell.
3. WHEN a new Game_Session begins, THE Timer SHALL reset to the Time_Limit and remain paused until the Avatar first moves or a maximum of 1 second elapses, whichever occurs first.
4. WHEN a new Game_Session begins, THE Maze_Game SHALL clear any previously displayed result message so that no result message from a prior Game_Session remains visible.
5. IF the Player activates the start control while a Game_Session is already in progress, THEN THE Maze_Game SHALL discard the in-progress Game_Session and begin a new Game_Session, retaining no state from the discarded session.

### Requirement 7: Configure the Time Limit

**User Story:** As a Player, I want the time limit to be defined for the game, so that the challenge duration is clear and consistent.

#### Acceptance Criteria

1. THE Maze_Game SHALL define a Time_Limit as an integer number of seconds between 30 and 600 inclusive.
2. WHERE no Player-specified Time_Limit is provided, THE Maze_Game SHALL apply a default Time_Limit of 60 seconds.
3. IF a Player-specified Time_Limit is not an integer, is less than 30, or is greater than 600, THEN THE Maze_Game SHALL reject the value, apply the default Time_Limit of 60 seconds, and present an indication that the specified Time_Limit was invalid.
4. WHEN a valid Player-specified Time_Limit is provided, THE Maze_Game SHALL apply that value as the active Time_Limit for the game.
