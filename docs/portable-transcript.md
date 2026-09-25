# The portable transcript

A conversation, in a shape no engine owns.

`moshcode handoff <from> <to>` reads one coding engine's session log, writes the
result as a file in this format, and starts the other engine pointed at it. This
document is that format. It is written down rather than left as an internal
shape so that a twelfth engine only needs a reader and a writer to join, and so
that anything else that wants to move a conversation can produce one of these
without reading moshcode's source.

Specified by PRD [0018](../prd/0018-take-what-omp-got-right.md) R3.

## The file

One JSON document, UTF-8, written to `~/.moshcode/handoffs/<id>.json` with mode
0600. The id is `<from>-<to>-<HHMMSS UTC>`.

```json
{
  "portable_transcript": "0.1",
  "generated": {
    "by": "moshcode 0.105.0",
    "at": "2026-09-25T18:22:41Z",
    "to": "codex"
  },
  "source": {
    "engine": "claude",
    "session": "c41b501f-de0a-411d-90a9-1e858636a4c2",
    "cwd": "/home/anthony/src/profullstack/niche-db",
    "started": "2026-09-25T17:04:02Z",
    "ended": "2026-09-25T18:21:55Z",
    "messages": 318,
    "dropped": 118
  },
  "messages": [
    { "role": "user", "at": "2026-09-25T17:04:02Z", "text": "migrate this db off railway" },
    { "role": "assistant", "at": "2026-09-25T17:04:19Z", "text": "I will start with the schema." }
  ],
  "changes": [
    { "path": "/home/anthony/src/profullstack/niche-db/docker-compose.yml", "action": "written" }
  ]
}
```

## Fields

| field | type | required | meaning |
|---|---|---|---|
| `portable_transcript` | string | yes | format version, `major.minor`. A reader that does not know the major must refuse. |
| `generated.by` | string | yes | what wrote the file, name and version. |
| `generated.at` | string | yes | ISO 8601 UTC, seconds precision. |
| `generated.to` | string | no | the engine this copy was rendered for. Absent means nobody in particular. |
| `source.engine` | string | yes | the engine the conversation was read from. |
| `source.session` | string | yes | that engine's own id for the session. |
| `source.cwd` | string | yes | the directory the session ran in. May be empty when the engine records none. |
| `source.started` | string or null | yes | first timestamp in the session. |
| `source.ended` | string or null | yes | last timestamp in the session. |
| `source.messages` | number | yes | how many messages the session held before any cap. |
| `source.dropped` | number | yes | how many were left out. Non-zero means this is an excerpt. |
| `messages` | array | yes | the conversation, oldest first. |
| `messages[].role` | string | yes | `user` or `assistant`. |
| `messages[].at` | string or null | yes | when it was said, or null when the engine stamped nothing. |
| `messages[].text` | string | yes | what was said, as plain text. |
| `changes` | array | yes | files the source session wrote. May be empty. |
| `changes[].path` | string | yes | absolute path as the engine recorded it. |
| `changes[].action` | string | yes | `written`. More verbs may be added; a reader must tolerate one it does not know. |

## Rules

**The conversation travels. The edits do not.** `changes` names the files the
previous engine wrote and stops there. It carries no diffs and no contents,
because the working tree already holds the result and a transcript full of
patches invites a receiving engine to apply changes that are already applied.
The tree is the state of the work. This file is the account of how it got there.

**Only `user` and `assistant` turns are messages.** A model's thinking blocks,
its tool calls, the tool output replayed back at it, and the system prompt are
all left out. They are the engine talking to itself in its own vocabulary, and
none of it survives a move to a different model.

**Text an engine injected on the user's behalf is not a message.** Every engine
opens a session by writing a machine-generated block into the first user turn:
Claude Code's `<system-reminder>`, Codex's `<environment_context>` and
`<user_instructions>`. Carrying those is worse than dropping them, because the
receiving engine writes its own and the pair then disagree about the date, the
shell and the working directory.

**An excerpt says so.** When a cap drops messages, the newest are kept and
`source.dropped` is non-zero. A reader must not treat `messages` as the whole
conversation without checking it.

**A message may be clipped.** A single message longer than 8000 characters ends
with a line reading `… (clipped)`. Clipping one message does not change
`source.messages` or `source.dropped`.

**An empty `messages` array is invalid.** A conversation with nothing in it is
not a short conversation, it is a failed read, and a writer must refuse rather
than emit one.

## What is fed to the target engine

The file is not pasted into the engine. Every engine takes its first prompt as
one argv value, and argv is bounded at roughly 2MB on Linux, so a long session
would fail at exec time. A prompt typed into a live pane is also submitted by
its first newline. So the seed is one line that names the file and tells the
engine to read it:

```
You are continuing a conversation that was running in claude. Read
/home/you/.moshcode/handoffs/claude-codex-182241.json first. It is a moshcode
portable transcript, version 0.1. It holds 200 messages (the newest of 318) and
a list of the files that were changed. The files were already written. The
working tree is the real state, so read it before you edit anything. Pick up
where the transcript stops.
```

That keeps one code path for every target engine, and it means the transcript
can be as long as the disk allows.

## Which engines can read and write it

Reading a conversation is harder than reading a token count, so the source list
is short and honest.

| engine | as a source | as a target |
|---|---|---|
| claude | yes, `~/.claude/projects/<slug>/<session>.jsonl` | yes, positional prompt |
| codex | yes, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | yes, positional prompt |
| opencode | yes, the `message` and `part` tables of its SQLite store | yes, `--prompt` |
| privacycode | yes, the same schema under its own data directory | yes, `--prompt` |
| qwen | no, its chats are under `~/.qwen/projects/<slug>/chats` and have no verified reader | yes, `-i` |
| gemini | no, moshcode knows of no session log to read | yes, `-i` |
| omp | no, moshcode knows of no session log to read | yes, positional prompt |
| kimi | no | no, `-p` prints one answer and exits |
| deepseek | no | no, `--headless -p` prints one answer and exits |
| mimocode | no | no, `run` prints one answer and exits |
| aider | no, its history is rendered prose with no turn markers | no, `--message` runs one exchange and exits |
| openagents | no, it launches engines and holds no conversation | no, same reason |

A refusal here is always by name and always with the reason. An engine that
cannot be read is not an engine with nothing to say, and an engine that answers
one prompt headlessly is not an engine that can receive a conversation.

## Versioning

`0.1` is the first version. A minor bump adds optional fields and a reader that
does not know them must ignore them. A major bump may change or remove a
required field, and a reader that does not know the major must refuse the file
rather than read what it recognises.
