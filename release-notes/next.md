# v2.1.6

- With `evalToolCallArgs` on, a tool call the model wrote as plain text (such as `[tool:lookup_customer]{"query":"acme"}`) is now recorded in `toolCalls` on a streamed run, so `tool_call_json_path` can check it. Before, the tool ran but the case failed with "no call to a matching tool".
- `tool_call_json_path` entries accept `matches` (a regular expression tested against the value), `present: false` (the argument must not be sent) and `all_calls: true` (every call to the tool must satisfy the entry, not just one).
