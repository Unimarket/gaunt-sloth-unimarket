/**
 * @packageDocumentation
 * GS2-16 — pure, fail-soft helpers that harvest per-run analytics (token usage + invoked tool
 * names) from LangChain messages, so the local history recorder can populate `gth insights`
 * with real numbers instead of zeros.
 *
 * The extraction is deliberately structural and defensive (duck-typed reads guarded by a
 * try/catch) rather than `instanceof`-based: the same accumulator serves both the non-streaming
 * `invoke` path (a full `messages[]` from graph state) and the streaming paths (individual
 * message chunks / `ToolMessage`s as they arrive), across providers whose message shapes vary.
 * Nothing here may throw into a run — a missing/odd field just means that datum is skipped.
 */
import { mcpToolErrorPayload } from '#src/core/mcpErrorPayload.js';
import type { GthRunStats, GthToolResult } from '#src/core/types.js';

/**
 * BATCH-21 / BATCH-49 — the DEFAULT cap on a captured tool-result payload, in **UTF-8 bytes**.
 *
 * Deliberately bytes, and deliberately a change from the character count this used to be. The cap
 * was applied to `text.length`, which counts UTF-16 code units, while every user-facing sentence
 * about it said "8 KB" — exact only for ASCII, and a different size from the one the code cut at
 * the moment a payload contained a character outside the ASCII range. Measuring UTF-8 bytes is what
 * those sentences already claimed, and it is the unit both neighbouring caps
 * (`builtInTools.<tool>.maxOutputBytes` / `maxBytes`) already use, so one number now means one size
 * to the person setting it and to the code applying it. An ASCII payload behaves exactly as it did
 * at this default; a non-ASCII one is cut somewhat earlier, which is the size the docs promised.
 *
 * This constant is the default's single source. A configured `toolResultCaptureMaxBytes` overrides
 * it at the read site (`resolveToolResultCaptureMaxBytes`); nothing else may restate the number.
 */
export const TOOL_RESULT_CONTENT_CAP = 8192;

/**
 * BATCH-49 — one captured payload after the cap has been applied: the text that is safe to store,
 * and whether the cap is what produced it.
 *
 * `truncated` is recorded HERE, at capture, rather than inferred later from the stored length. The
 * cut is on a character boundary (see {@link capToolResultText}), so a truncated payload can land
 * up to three bytes under the cap, and `.length` does not count bytes at all — a check that
 * compared the stored length with the cap would both miss real truncations and fire on a payload
 * that merely happened to be the same length. The capture site is the only place that still holds
 * the original, so it is the only place the fact can be recorded honestly.
 */
export interface CappedToolResultText {
  /** The payload as stored: the original when it fitted, the character-boundary prefix when it did not. */
  text: string;
  /** `true` iff `text` is a prefix of a longer payload — the cap is what cut it. */
  truncated: boolean;
  /**
   * The original payload's size in UTF-8 bytes, recorded only when {@link truncated} is `true`.
   *
   * This is the number a person needs in order to choose a new cap: the stored prefix's length
   * cannot say how far short the cut fell, and a reason string that only names the key still
   * leaves them guessing what to raise it to.
   */
  originalBytes?: number;
}

/**
 * BATCH-49 — apply `maxBytes` to `text`, cutting on a character boundary so the stored prefix is
 * always valid UTF-8.
 *
 * A byte cap applied as `slice` would split a multi-byte character: UTF-8 encodes one code point
 * in up to four bytes, and a cut that lands inside one yields a string that does not decode. So
 * the cut walks back to the start of the character the byte budget ran out inside, which means a
 * truncated payload can be up to three bytes *under* the cap and is never over it. A payload that
 * fits is returned unchanged, with `truncated: false` and no `originalBytes` — absence is the
 * record of "nothing was cut", and recording a size on every result would bloat the very trace
 * the cap exists to bound.
 *
 * `maxBytes` is a positive integer by the time it arrives here: the config schema rejects
 * anything else, and the read site substitutes {@link TOOL_RESULT_CONTENT_CAP} for an absent key.
 * Zero is not "unlimited" and is not handled here — see the schema comment for why.
 */
export function capToolResultText(text: string, maxBytes: number): CappedToolResultText {
  const encoded = Buffer.from(text);
  if (encoded.length <= maxBytes) return { text, truncated: false };

  // A continuation byte is 10xxxxxx. `encoded[maxBytes]` is the first byte that does not fit. When
  // it is a continuation, the character started inside the budget; walk back onto its lead and end
  // the prefix BEFORE that lead. `subarray` is exclusive, so stopping ON the lead is what drops it:
  // including the lead emits a truncated code point, and `toString` on that sequence substitutes
  // U+FFFD and still "decodes", which is a split papered over rather than avoided. A lead or an ASCII
  // byte at `encoded[maxBytes]` is already a character boundary, so the walk does not move and the
  // cut stays at the budget. The prefix is a genuine prefix of `text`, up to three bytes under the
  // cap, and never over it.
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: encoded.subarray(0, end).toString('utf8'),
    truncated: true,
    originalBytes: encoded.length,
  };
}

/**
 * One tool call the model requested, held until the `ToolMessage` carrying its `tool_call_id`
 * arrives. `argsText` is the arguments as JSON text: the serialised `args` of a complete call, or
 * the concatenated `args` fragments of a streamed one. It is `undefined` when a complete call's
 * `args` could not be serialised, so the call still occupies its place in the queue for its id.
 */
export interface PendingToolCall {
  argsText?: string;
}

/** Mutable tally behind {@link finalizeRunStats}; see {@link createRunStatsAccumulator}. */
export interface RunStatsAccumulator {
  /** Running sum of input/prompt tokens. */
  input: number;
  /** Running sum of output/completion tokens. */
  output: number;
  /** Whether ANY message reported `usage_metadata` — gates whether tokens are recorded at all. */
  sawUsage: boolean;
  /** Deduplicated set of invoked tool names. */
  tools: Set<string>;
  /** BATCH-21 — one record per executed tool result (`ToolMessage`), in arrival order, un-deduped. */
  toolResults: GthToolResult[];
  /**
   * Requested tool calls that no `ToolMessage` has claimed yet, keyed by tool-call id. A queue per
   * id rather than one entry, because some providers reuse an id within a run: each result claims
   * the oldest call still waiting under its id.
   */
  pendingToolCalls: Map<string, PendingToolCall[]>;
  /**
   * The current model round's streamed tool calls, keyed by `tool_call_chunks[].index`. Cleared
   * when a `ToolMessage` arrives, because providers restart the index at 0 every round.
   */
  streamingToolCalls: Map<number, PendingToolCall & { id?: string }>;
  /**
   * Ids of messages whose tool calls {@link accumulatePromotedToolCalls} already recorded, so the
   * same message folded later through {@link accumulateMessage} is not recorded a second time.
   */
  promotedMessageIds: Set<string>;
}

/** A fresh, empty accumulator. */
export function createRunStatsAccumulator(): RunStatsAccumulator {
  return {
    input: 0,
    output: 0,
    sawUsage: false,
    tools: new Set<string>(),
    toolResults: [],
    pendingToolCalls: new Map(),
    streamingToolCalls: new Map(),
    promotedMessageIds: new Set(),
  };
}

function queueToolCall(acc: RunStatsAccumulator, id: string, call: PendingToolCall): void {
  const queue = acc.pendingToolCalls.get(id);
  if (queue) queue.push(call);
  else acc.pendingToolCalls.set(id, [call]);
}

/**
 * Record the tool calls one AI message (or message chunk) requests, so their arguments can be
 * attached to the matching result later.
 *
 * - A message carrying `tool_call_chunks` is read from those deltas only. On the streaming path
 *   every chunk also carries `tool_calls`, but each chunk's are parsed from that chunk's fragment
 *   alone, so they hold partial (often empty) arguments. The fragments are appended to the call
 *   open at their `index` until the round's results arrive.
 * - A delta whose `id` differs from the call open at its `index` starts a new call: a provider that
 *   sends no `index` puts every call of a round at 0.
 * - A message with no deltas carries complete `tool_calls`, recorded as they are, unless the
 *   message was already recorded as promoted.
 * - A call without an id cannot be correlated with a result and is not recorded.
 */
function recordRequestedToolCalls(acc: RunStatsAccumulator, m: Record<string, unknown>): void {
  const deltas = m.tool_call_chunks;
  if (Array.isArray(deltas) && deltas.length > 0) {
    for (const delta of deltas) {
      if (!delta || typeof delta !== 'object') continue;
      const index = typeof delta.index === 'number' ? delta.index : 0;
      const id = typeof delta.id === 'string' && delta.id.length > 0 ? delta.id : undefined;
      let call = acc.streamingToolCalls.get(index);
      if (call && id && call.id && call.id !== id) call = undefined;
      if (!call) {
        call = { argsText: '' };
        acc.streamingToolCalls.set(index, call);
      }
      if (id && !call.id) {
        call.id = id;
        queueToolCall(acc, id, call);
      }
      if (typeof delta.args === 'string') call.argsText += delta.args;
    }
    return;
  }

  const toolCalls = m.tool_calls;
  if (!Array.isArray(toolCalls)) return;
  if (typeof m.id === 'string' && acc.promotedMessageIds.has(m.id)) return;
  for (const tc of toolCalls) {
    const id = tc?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    let argsText: string | undefined;
    try {
      argsText = JSON.stringify(tc.args ?? {});
    } catch {
      /* fail-soft: an unserialisable `args` is recorded as no arguments */
    }
    queueToolCall(acc, id, { argsText });
  }
}

/**
 * Record the tool calls of an AI message the tool-call repair promoted from text, which keeps the
 * id of the text message it replaces. A streamed run has already seen that id as plain text and
 * never delivers the promoted message to {@link accumulateMessage}, so the agent hands it here
 * when it promotes it.
 *
 * Records only the requested calls and their names: the message's usage was already counted from
 * the text it replaces. The message is remembered by id, so a run that also folds the finished
 * message (the non-streaming path) does not record its calls twice. Fail-soft.
 */
export function accumulatePromotedToolCalls(acc: RunStatsAccumulator, message: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = message as any;
    if (!m || typeof m !== 'object' || !Array.isArray(m.tool_calls)) return;
    for (const tc of m.tool_calls) {
      const name = tc?.name;
      if (typeof name === 'string' && name.length > 0) acc.tools.add(name);
    }
    recordRequestedToolCalls(acc, m);
    if (typeof m.id === 'string') acc.promotedMessageIds.add(m.id);
  } catch {
    /* fail-soft: never let stats capture affect a run */
  }
}

/**
 * Claim the oldest call waiting under `toolCallId` and return its arguments as capped JSON text,
 * or `undefined` when there is no such call or its arguments could not be serialised.
 *
 * Arguments that parse as JSON are re-serialised compactly, so a streamed call and the same call
 * read from a finished message record identical text. Streamed fragments that do not parse are
 * kept as the model sent them. An empty streamed buffer is a call with no arguments, recorded as
 * `{}`, which is what the tool was invoked with.
 */
function claimToolCallArgs(
  acc: RunStatsAccumulator,
  toolCallId: unknown,
  maxBytes: number
): CappedToolResultText | undefined {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return undefined;
  const queue = acc.pendingToolCalls.get(toolCallId);
  const call = queue?.shift();
  if (queue && queue.length === 0) acc.pendingToolCalls.delete(toolCallId);
  if (call?.argsText === undefined) return undefined;

  let text = call.argsText.trim() === '' ? '{}' : call.argsText;
  try {
    text = JSON.stringify(JSON.parse(text));
  } catch {
    /* not JSON: kept verbatim */
  }
  return capToolResultText(text, maxBytes);
}

/**
 * BATCH-21 — derive a tool result's text payload from a `ToolMessage.content`, fail-soft. A string
 * passes through; anything else non-`undefined` is JSON-stringified (the same derivation the
 * `tool_result` stream event uses in `GthAbstractAgent`); the result is capped at `maxBytes`
 * UTF-8 bytes (see {@link capToolResultText}). Returns `undefined` (payload omitted) when nothing
 * textual can be derived — never throws.
 *
 * **A single content block is captured as the block, NOT unwrapped to its inner text — deliberately.**
 * The alternative (unwrap a lone `{type:'text',text}` so an eval's `tool_result_json_path` reaches
 * the inner JSON without a `text` hop) was considered and rejected:
 *
 * - **The capture must be what the MODEL observed.** That is the one property a tool-result trace
 *   exists to preserve; an eval that grades a payload the model never saw grades a fiction.
 * - **No shape is unreachable, so nothing is being worked around.** `resolveJsonPath` normalizes
 *   `[0]` index syntax, so a block reachable at `text` in the object form is reachable at `[0].text`
 *   in the array form; a bare-string payload parses directly.
 * - **Unwrapping would silently break suites already written to the documented `text` hop**, and it
 *   would make the capture depend on which MCP-adapter branch produced the content (a lone text
 *   block arrives as a bare string, but as a block object once the server also returns
 *   `structuredContent`/`_meta`) — swapping a stated contract for an inferred one.
 * - It would not help the case this capture exists for anyway: a SOFTENED MCP error's payload is
 *   the adapter's own error message (prose, then the server's text), so it is not JSON at any hop.
 */
function toolResultContentText(
  content: unknown,
  maxBytes: number
): CappedToolResultText | undefined {
  try {
    let text: string | undefined;
    if (typeof content === 'string') {
      text = content;
    } else if (content !== undefined) {
      text = JSON.stringify(content);
    }
    if (text === undefined) return undefined;
    return capToolResultText(text, maxBytes);
  } catch {
    /* fail-soft: an unstringifiable payload just means no content is recorded */
    return undefined;
  }
}

/**
 * Fold one LangChain message (or message chunk) into the accumulator. Fail-soft: any unexpected
 * shape is swallowed so a run is never affected. Harvests, when present:
 * - `usage_metadata.input_tokens` / `.output_tokens` (summed; marks `sawUsage`),
 * - tool names from an AIMessage's requested `tool_calls[].name` AND from a `ToolMessage`'s own
 *   `.name` (the executed tool), so both "requested" and "executed" tools are captured, and
 * - (BATCH-21) a per-`ToolMessage` result record — `name` + `isError` (from `.status`) + capped
 *   `content` — into `acc.toolResults`, so tool-RESULT assertions can grade what a tool returned,
 * - and on that record, the capped `args` of the requested call whose id is the result's
 *   `tool_call_id`, so argument assertions can grade what the model asked the tool to do. A call
 *   no result answers produces no record; it stays visible to name assertions through `tools`.
 *
 * `configuredMcpServers` is `Object.keys(config.mcpServers)`, used only to resolve which server an
 * errored MCP tool belongs to (BATCH-43; see the record's `errorPayload`). It is passed per fold
 * rather than held on the accumulator so this never depends on the accumulator being re-created
 * after the config is known — the default leaves every non-MCP capture exactly as it was.
 *
 * `captureMaxBytes` is the same kind of argument, for the same reason (BATCH-49): the cap is a
 * config value (`toolResultCaptureMaxBytes`, defaulted at the read site), and holding it on the
 * accumulator would tie every fold to the accumulator having been rebuilt after the config was
 * known. The default is {@link TOOL_RESULT_CONTENT_CAP}, so a caller that predates the argument
 * caps exactly where it always did.
 */
export function accumulateMessage(
  acc: RunStatsAccumulator,
  message: unknown,
  configuredMcpServers: Iterable<string> = [],
  captureMaxBytes: number = TOOL_RESULT_CONTENT_CAP
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = message as any;
    if (!m || typeof m !== 'object') return;

    const usage = m.usage_metadata;
    if (usage && typeof usage === 'object') {
      acc.sawUsage = true;
      if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
        acc.input += usage.input_tokens;
      }
      if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
        acc.output += usage.output_tokens;
      }
    }

    // Requested tool calls (AIMessage / AIMessageChunk). Continuation chunks in a streamed
    // tool call carry an empty name, so guard on a non-empty string; the Set dedupes repeats.
    const toolCalls = m.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const name = tc?.name;
        if (typeof name === 'string' && name.length > 0) acc.tools.add(name);
      }
    }
    recordRequestedToolCalls(acc, m);

    // Executed tool result (ToolMessage). Its `.name` is the tool that produced the result.
    const type: unknown = typeof m.getType === 'function' ? m.getType() : m._getType?.();
    // The arguments of the call this result answers, matched on `tool_call_id`. Claimed for every
    // result, named or not, so a reused id always pairs each result with its own call.
    let args: CappedToolResultText | undefined;
    if (type === 'tool') {
      // A result closes the round its call was streamed in; the next round's indexes restart at 0.
      acc.streamingToolCalls.clear();
      args = claimToolCallArgs(acc, m.tool_call_id, captureMaxBytes);
    }
    if (type === 'tool' && typeof m.name === 'string' && m.name.length > 0) {
      acc.tools.add(m.name);
      // BATCH-21 — capture the RESULT record too (same capture site, same fail-soft discipline):
      // `.status === 'error'` is LangChain's real tool-error signal, `.content` the returned
      // payload (capped; omitted when no text can be derived). One record per ToolMessage, in
      // arrival order — deliberately NOT deduplicated, unlike the name set above.
      const captured = toolResultContentText(m.content, captureMaxBytes);
      // BATCH-43 — beside the observed payload, never instead of it: an errored MCP tool's result
      // is the adapter's own prose-prefixed message, which `tool_result_json_path` cannot parse.
      // `mcpToolErrorPayload` rebuilds that prefix from the resolved server + tool name and strips
      // it, yielding the server's own error body when (and only when) it is JSON. Derived from the
      // RAW `m.content`, not from the capped `captured` above — deriving after the cap would work
      // on every payload short enough to test with and silently stop working on the long ones. The
      // SAME cap is applied inside, to the derived payload: the two fields share one budget, so a
      // raised `toolResultCaptureMaxBytes` recovers an error body the default would have dropped,
      // and a lowered one drops one the default would have kept.
      const isError = m.status === 'error';
      const errorPayload = mcpToolErrorPayload(
        { name: m.name, isError, content: m.content },
        configuredMcpServers,
        captureMaxBytes
      );
      // BATCH-49 — the truncation fact rides the record, recorded at this capture rather than
      // inferred later from the stored length (see {@link CappedToolResultText}). `contentTruncated`
      // is present only when the cap cut something, so a record that fitted is byte-identical to the
      // one this capture produced before the field existed.
      // `args` is absent when no requested call carries this result's id. It is capped at the
      // configured size.
      acc.toolResults.push({
        name: m.name,
        isError,
        ...(captured !== undefined ? { content: captured.text } : {}),
        ...(captured?.truncated
          ? { contentTruncated: true, contentOriginalBytes: captured.originalBytes }
          : {}),
        ...(errorPayload !== undefined ? { errorPayload } : {}),
        ...(args !== undefined ? { args: args.text } : {}),
        ...(args?.truncated ? { argsTruncated: true, argsOriginalBytes: args.originalBytes } : {}),
      });
    }
  } catch {
    /* fail-soft: never let stats capture affect a run */
  }
}

/** Freeze the accumulator into the public {@link GthRunStats}. Tokens omitted unless observed. */
export function finalizeRunStats(acc: RunStatsAccumulator): GthRunStats {
  return {
    tokensInput: acc.sawUsage ? acc.input : undefined,
    tokensOutput: acc.sawUsage ? acc.output : undefined,
    tools: [...acc.tools],
    toolResults: [...acc.toolResults],
  };
}

/**
 * One-shot convenience for the non-streaming path: fold a full `messages[]` (e.g. the final graph
 * state) into a fresh accumulator and finalize. Fail-soft (a non-iterable input yields empties).
 */
export function extractRunStats(
  messages: unknown,
  configuredMcpServers: Iterable<string> = [],
  captureMaxBytes: number = TOOL_RESULT_CONTENT_CAP
): GthRunStats {
  const acc = createRunStatsAccumulator();
  try {
    if (Array.isArray(messages)) {
      for (const m of messages) accumulateMessage(acc, m, configuredMcpServers, captureMaxBytes);
    }
  } catch {
    /* fail-soft */
  }
  return finalizeRunStats(acc);
}
