# v2.1.5

- `gth eval` records the arguments of each tool call beside its result, as `args` in `results.json` and the per-case files, and the new [`tool_args`](https://github.com/pukeko-robotics/gaunt-sloth/blob/v2.1.5/docs/COMMANDS.md#tool-argument-assertions) assertion checks them with `equals`, `contains`, `matches`, `exists` or `absent`. Recorded arguments are capped by `toolResultCaptureMaxBytes`, like result payloads.
