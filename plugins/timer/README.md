# timer

Slash commands for [`@profullstack/timer`](https://github.com/profullstack/timer)
— a time tracker that runs on Linux, macOS and Windows, and answers `--json` on
every command so an agent can clock its own work.

```
/timer:start acme fix the login redirect
/timer:status
/timer:stop
/timer:report --week --group day
```

## Install the CLI

```sh
npm install -g @profullstack/timer
```

or, inside moshcode:

```
moshcode install timer
```

## What it is for

An hour of agentic work is an hour times however many engines ran in it, so an
entry carries an agent count (`--agents 4`). `@profullstack/billing` multiplies
by it when the rate says to and ignores it when the rate is flat.

Several clocks may run at once. That is deliberate: parallel agents each track
their own work and do not stop each other.

The timesheet is one JSON file at `~/.profullstack/timer/timesheet.json`, and
billing reads it directly.
