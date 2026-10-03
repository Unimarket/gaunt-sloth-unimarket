# Draft: upstream issue and pull request text for patch 3

Not yet filed. Plain text for a human reader; keep it short.

## Issue

**Title:** Assert on tool-call arguments in `gth eval`

**Body:**

`gth eval` can check that a tool was called (`must_call`) and what it returned (`tool_result_json_path`, `must_error`), but not what it was called with. That leaves a gap when testing an MCP server's tool descriptions: whether the model passed the right arguments, such as an id rather than a display name, or an optional filter it was not asked for.

Proposal: record each tool call's arguments beside its result in `results.json`, and add a `tool_args` check:

```yaml
tool_args:
  - { tool: "mcp__crm__search", path: "query", matches: "^acme" }
  - { tool: "mcp__crm__search", path: "limit", absent: true, every: true }
```

A PR is ready and tested. Is this wanted, and is the shape right?

## Pull request

**Title:** Record tool-call arguments in eval results and add a `tool_args` check

**Body:**

### Gap

`gth eval` records which tools were called and what they returned, but not the arguments, so a suite cannot assert what the model asked a tool to do.

### What this adds

- `args` on each tool result in `results.json` and the per-case files: the arguments as compact JSON text, matched to the result by tool-call id, capped by `toolResultCaptureMaxBytes` (`argsTruncated`, `argsOriginalBytes` when cut).
- A `tool_args` check: a tool pattern, a path into the arguments, and one of `equals`, `contains`, `matches` or `absent: true` (no operator means the path exists). It passes when at least one matching call satisfies it; `every: true` requires all of them to.
- A fix so a tool call the repair step promotes from model text is recorded on streamed runs too.

### Behaviour to know

- Only calls with a result are recorded, so a call that never ran is invisible to `tool_args`.
- `tool_args` rejects unknown keys, unlike `tool_result_json_path`, because a misspelt operator would otherwise be silently dropped and weaken the entry to a path-exists check. Happy to follow the sibling's lenient parsing if you prefer.
- The grading shared with `tool_result_json_path` moved to one helper; that check's output is unchanged.

### Tests

Unit specs for capture (id matching, parallel and reused ids, caps, every streaming shape), the check and the parser. An end-to-end spec runs the real eval path against a scripted streaming model and checks the written results, streaming and not. `pnpm test`, lint and `docs:check` pass.

### Questions

- Is `every: true` the right spelling for the all-calls quantifier?
- Should unknown-key rejection apply to `tool_result_json_path` too, as a separate change?
