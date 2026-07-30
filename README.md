# cclens

**See what Claude Code is actually doing.**

cclens sits on the wire. A local proxy captures the real API traffic — not just the session files on disk — and joins it with transcripts and hook events: three layers of ground truth in one timeline, down to the raw payloads.

Zero dependencies. No daemon, no background state. No telemetry — cclens sends nothing anywhere.

![cclens dashboard](https://raw.githubusercontent.com/an7tang/cclens/main/docs/shots/dashboard.png)

```sh
npm install -g cclens
cclens claude      # run claude with the wire captured
cclens            # look at what you captured
```

`cclens claude` points that one process at a local proxy through its own environment and nothing else — no config is written, so nothing can be left pointing at a port that stopped listening. Add `cclens install` once for the hook layer.

Nothing to configure before the first run: `cclens` on its own reads the transcripts Claude Code has been writing all along.

## Why the wire matters

The transcript on disk tells you what was said. It cannot tell you what it cost, what it retried, or where the time went.

![request detail](https://raw.githubusercontent.com/an7tang/cclens/main/docs/shots/request-detail-sse.png)

One request, fully accounted for: the cached prefix broke because the tool set changed, 28.5K tokens were rewritten at 1.25× while cache reads bill at 0.1× — about $0.164 extra, attributed to a cause rather than left as a mystery. The 655ms gap before it is 652ms of measured `Read` execution plus 3ms of harness. The response arrived as 17 SSE events, first byte at 644ms.

The same view surfaces the retries after a 529, the background calls you never asked for (quota probes, title generation, permission review, goal evaluation), and the longest pause mid-generation.

## Three layers, and they are not alike

Two of the three need no process at all, and the commands say so rather than pretending they are three symmetric switches.

**API** — a transparent proxy. The only layer that must sit in the network path, so the only one that needs something running. Capture is write-ahead, so an interrupted stream is still recorded; message bodies are deduplicated by content hash, so a full history costs a fraction of the traffic; and request *lineage* — continues, retry, compact, rewrite, resend, new branch — is derived from hash-array prefixes rather than guesswork.

![request lineage with hook events](https://raw.githubusercontent.com/an7tang/cclens/main/docs/shots/lineage-hooks.png)

**Hooks** — a recorder for all 12 Claude Code hook events, threaded through the lineage as a local-events lane: measured tool duration, permission waits, subagent lifecycle, compaction. Above, a `Task` spawn brackets its subagent group, and the `Edit` that waited 151ms for approval says so. Registered once with `cclens install`; after that Claude Code invokes the recorder itself, so events keep landing on disk with nothing of ours running, across reboots — and a failing hook can never break `claude`.

**Transcripts** — every session JSONL Claude Code writes, browsable and searchable, subagents included. Nothing to install: Claude Code writes these whether or not cclens exists, and cclens only reads them. Follow a running session live, or export one as a single self-contained HTML file.

![transcript session](https://raw.githubusercontent.com/an7tang/cclens/main/docs/shots/transcript-session.png)

The layers cross-link on real keys — `session_id`, message id, `tool_use_id` — so a request, its transcript, and the hook events it caused are one click apart.

## Honest by construction

An observability tool that guesses is worse than none. So: one hook event is one row with one payload, never merged. Measured values and derived values are marked differently. Events that cannot be attributed with hard evidence say so instead of being placed by vibe. And if an event type has neither a recorder nor recorded data, the legend names it — because absent is not the same as didn't happen.

## Commands

Four commands are the whole tool:

| | |
| --- | --- |
| `cclens` | Look at everything recorded so far. Ctrl+C stops it |
| `cclens claude` | Run `claude` with the wire captured |
| `cclens install` | Install the hook recorder, once |
| `cclens status` | What's recording, and what's stored |

| | |
| --- | --- |
| `cclens uninstall` | The exact inverse of `install` |
| `cclens export F.jsonl` | Standalone HTML snapshot of one transcript |
| `cclens <cmd> [args…]` | Wrap any command, not just `claude` — Agent SDK scripts too |

`--port <n>`, `--no-open` · `CCLENS_HOME` relocates the whole store · `CCLENS_PORT`, `CCLENS_DATA`, `CCLENS_UPSTREAM`, `CCLENS_TRANSCRIPTS`, `CCLENS_HOOKS_DATA` override one thing each

Flags come before the command; everything after it passes through untouched. `cclens help --all` explains why each layer gets the shape it does.

There is no `on`/`off`, and no background service. Nothing cclens does outlives a command you can see: capture is scoped to the process you wrapped, and viewing is a foreground server. Want every session captured? `alias claude='cclens claude'` — explicit, visible in your own shell config, and reversible by deleting one line. The alternative would be writing a lasting `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`, and a pointer that outlives the process it names is exactly how an observability tool ends up breaking the thing it observes.

## Data & privacy

Everything cclens records lives under **`~/.claude/cclens/`** — inside Claude Code's own directory, so backing up or moving `~/.claude` carries the recordings with it.

That content is your prompts, your code, and Claude's responses, stored **in plaintext**. Since `~/.claude` is often kept under version control for `settings.json`, `CLAUDE.md`, `agents/` and `skills/`, cclens seeds a `.gitignore` in its own directory that excludes it — so a stray `git add -A` in `~/.claude` can't commit your captures. Treat the data like shell history regardless: keep it local.

`cclens uninstall` removes the hook recorder. `rm -rf ~/.claude/cclens` erases the recordings too, and `CCLENS_HOME` relocates all of it elsewhere. The proxy talks only to `api.anthropic.com` — or wherever `CCLENS_UPSTREAM` points.

## Requirements

Node ≥ 18. Built on macOS, works on Linux, untested on Windows.

## License

[MIT](LICENSE)
