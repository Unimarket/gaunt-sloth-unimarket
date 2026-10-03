# v2.1.5

- `gth eval` can check the arguments a tool was called with, not only that it was called: set `"evalToolCallArgs": true` in the config the run starts with and assert with `tool_call_json_path`. The arguments are then recorded in each case's `toolCalls`, as the model sent them.
