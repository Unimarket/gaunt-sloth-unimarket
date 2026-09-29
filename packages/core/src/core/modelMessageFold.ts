/**
 * [[EXT-205]] — fold a `streamMode: 'messages'` stream into one aggregate PER MODEL MESSAGE, so each
 * message's stop/finish reason is read on its own.
 *
 * The stream interleaves every model call the graph makes, and a middleware hook can make one with
 * no `ToolMessage` after it: the review rating call runs from `afterAgent`, calls the model directly
 * and invokes its tool directly. Folded into one aggregate with the answer turn, the two messages'
 * reasons concatenated (`stopstop`, and `max_tokensstop` for a truncated review, which no reader
 * recognises), so a truncated answer went unclassified and the finish-reason log attributed one
 * message's reason to another.
 *
 * **A message ends when a chunk arrives whose message id, or whose graph node, differs from the
 * current message's — and only when BOTH values are known.** LangGraph's messages handler
 * (`pregel/messages.js`, `StreamMessagesHandler._emit`) stamps every streamed chunk of one model run
 * with that run's stable id (the provider's own, else `run-<runId>`), and the node comes from the
 * run's metadata, which is fixed for the run. So on the real graph path both are present and change
 * exactly once per model call. A chunk that carries neither is joined to the current message rather
 * than starting a new one: a missing id is an absence of information, not evidence of a boundary,
 * and splitting on it would cut one message into pieces that each carry no reason.
 *
 * The fold does not decide what a message means. {@link isMiddlewareHookNode} says whether it
 * came from a middleware hook rather than from the agent's own model call; the caller decides what
 * that is worth.
 */
import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';

/** One model message the fold has seen to its end. */
export interface FinishedModelMessage {
  /** Every chunk of this message, concatenated. */
  message: AIMessageChunk;
  /** The graph node that produced it, when the stream said. */
  node: string | undefined;
}

/**
 * The suffixes `createAgent` gives a middleware hook's node: `${middleware.name}.before_agent`,
 * `.before_model`, `.after_model` and `.after_agent` (langchain `agents/ReactAgent.js`). A model call
 * made from one of them is the middleware's own call, never the agent's answer.
 */
const MIDDLEWARE_HOOK_SUFFIXES: readonly string[] = [
  '.before_agent',
  '.before_model',
  '.after_model',
  '.after_agent',
];

/** The `langgraph_node` a stream chunk's metadata names, or `undefined` when it names none. */
export function streamNodeOf(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const node = (metadata as { langgraph_node?: unknown }).langgraph_node;
  return typeof node === 'string' && node.length > 0 ? node : undefined;
}

/**
 * Whether a node is a middleware hook, so a model message it produced is the middleware's call and
 * not the agent's answer. An unknown node is NOT a hook: a stream that carries no metadata keeps
 * the behaviour it had before the node was read at all.
 */
export function isMiddlewareHookNode(node: string | undefined): boolean {
  return node !== undefined && MIDDLEWARE_HOOK_SUFFIXES.some((suffix) => node.endsWith(suffix));
}

function messageIdOf(chunk: AIMessageChunk): string | undefined {
  return typeof chunk.id === 'string' && chunk.id.length > 0 ? chunk.id : undefined;
}

/** See the module comment. One instance per stream. */
export class ModelMessageFold {
  private current: AIMessageChunk | null = null;
  private currentId: string | undefined;
  private currentNode: string | undefined;

  /**
   * Fold one AI chunk. Returns the PREVIOUS message when this chunk starts a new one, so the caller
   * can record it before it is gone; `null` otherwise.
   */
  add(chunk: AIMessageChunk, metadata: unknown): FinishedModelMessage | null {
    const id = messageIdOf(chunk);
    const node = streamNodeOf(metadata);
    let finished: FinishedModelMessage | null = null;
    if (this.current) {
      const idChanged = id !== undefined && this.currentId !== undefined && id !== this.currentId;
      const nodeChanged =
        node !== undefined && this.currentNode !== undefined && node !== this.currentNode;
      if (idChanged || nodeChanged) finished = this.finish();
    }
    this.current = this.current ? this.current.concat(chunk) : chunk;
    this.currentId ??= id;
    this.currentNode ??= node;
    return finished;
  }

  /**
   * End the current message, if there is one: at a `ToolMessage`, which closes the round, and at
   * the end of the stream. Returns `null` when no message was open.
   */
  finish(): FinishedModelMessage | null {
    if (!this.current) return null;
    const finished = { message: this.current, node: this.currentNode };
    this.current = null;
    this.currentId = undefined;
    this.currentNode = undefined;
    return finished;
  }
}

/**
 * [[EXT-205]] — the per-message record, and the choice of which message speaks for the turn.
 *
 * **Every model message is recorded when it finishes**, through the caller's `record`, so the
 * finish-reason log carries one entry per message: a message whose provider said nothing is
 * recorded as saying nothing, rather than borrowing its neighbour's reason by concatenation.
 *
 * **The turn is classified from the agent's LAST answer-side message**, returned by {@link end}:
 *
 * - **A middleware hook's message never classifies the turn.** The review rating call is the
 *   measured case: it runs from `review-rate.after_agent` after the answer is complete, so its
 *   `STOP` says nothing about whether the review was cut off, and its own truncation or refusal is
 *   not the review's. Recorded, never classified. The hook is recognised from the node name
 *   `createAgent` gives it ({@link isMiddlewareHookNode}), which covers every hook kind, not only
 *   this middleware.
 * - **A message followed by a `ToolMessage` does not classify the turn** — its round continued, so
 *   it is not how the turn ended. This is the rule the single aggregate already applied by
 *   resetting at a `ToolMessage`, and it is kept: a round's stop reason is recorded, and the turn is
 *   still classified only by the message the turn ended on.
 * - **Last, not first**, because one round can hold two of the agent's own model messages with no
 *   `ToolMessage` between them: a `wrapModelCall` retry or fallback calls the model again inside
 *   `model_request` (EXT-204's empty-turn retry is one), and the turn ended on the later attempt,
 *   not on the one that was replaced.
 *
 * A stream with no node metadata at all (synthetic streams) has no hooks to exclude, so the verdict
 * is the last message, which is what the single aggregate read before.
 */
export class TurnMessageReasons {
  private readonly fold = new ModelMessageFold();
  private verdict: AIMessageChunk | null = null;

  constructor(private readonly record: (message: AIMessageChunk) => void) {}

  /** Feed one stream item. Only AI chunks and `ToolMessage`s matter; anything else is ignored. */
  observe(chunk: unknown, metadata: unknown): void {
    if (AIMessageChunk.isInstance(chunk)) {
      this.settle(this.fold.add(chunk, metadata));
    } else if (chunk instanceof ToolMessage) {
      this.settle(this.fold.finish());
      this.verdict = null;
    }
  }

  /**
   * End the stream: record the last open message, then return the message that classifies the
   * turn, or `null` when there is none (an empty stream, or one that ended on a tool round).
   */
  end(): AIMessageChunk | null {
    this.settle(this.fold.finish());
    return this.verdict;
  }

  private settle(finished: FinishedModelMessage | null): void {
    if (!finished) return;
    this.record(finished.message);
    if (!isMiddlewareHookNode(finished.node)) this.verdict = finished.message;
  }
}
