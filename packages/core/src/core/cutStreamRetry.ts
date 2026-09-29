/**
 * @packageDocumentation
 * [[EXT-204]] — call the model once more when its reply was cut off before it finished.
 *
 * Measured on Gemini 3.8 Flash on VertexAI (gaunt-sloth issue #465): after a tool result, the model's
 * next message sometimes arrives with only `thought: true` text parts — no answer text, no tool call,
 * **no finish reason** and all-zero usage — while every complete message in the same run carries a
 * finish reason and real usage. Its thoughts are mid-plan. The stream ended before its final chunk,
 * and the run then ended `empty_response@runner.empty-stream` with nothing to recover it.
 *
 * ## Where the retry lives, and why here
 *
 * **Chosen: inside the model call**, as a `wrapModelCall` middleware that calls the handler once
 * more when the reply it got back was cut. **Rejected: at the runner**, after the stream has drained,
 * by removing the cut message from the checkpointed thread and running the graph again.
 *
 * The node's scope describes the runner shape ("remove that message from the checkpointed thread and
 * call the model once more, so the thread ends with the tool result"). The in-call retry meets every
 * part of that intent without the thread surgery:
 *
 * - **The cut message never reaches the thread.** `createAgent` puts into state only the message the
 *   outermost `wrapModelCall` returns (langchain 1.5 `AgentNode`), so the request the retry sends is
 *   the one the cut call was sent: it ends with the tool result, never with a model turn. Gemini's
 *   400 ("Requests ending with a model turn are not supported", [[EXT-203]]) cannot arise, and no
 *   message has to be found and removed from a checkpoint.
 * - **Exactly one extra model call**, and no input the user never sent. The same request is sent
 *   again; nothing is appended to it.
 * - **The review rating runs once, on the real answer.** On `pr` and `review` the rating is an
 *   `afterAgent` hook, so it runs when the agent loop ends — which, at the runner, is BEFORE the
 *   runner sees the empty result. A runner retry would therefore find the empty review already
 *   rated (PASS 10/10 in the reproduction) and would have to undo or re-run the rating as well. Here
 *   the loop has not ended yet when the retry happens, so the rating only ever sees the recovered
 *   answer.
 * - **Every path gets it.** The string stream, the typed-event stream and the non-streaming `invoke`
 *   all run the same graph, so one seam covers all three; a runner retry would need one per path.
 * - [[EXT-205]]'s per-message fold classifies the turn from the LAST message of the agent's own node,
 *   deliberately so that a retry inside `model_request` is classified from the retried message. The
 *   cut message is still recorded in the finish-reason log, as absent, which is what it was.
 *
 * What it costs: the cut attempt's chunks have already streamed by the time it is recognised. The
 * plain surface and the output file show only answer text, and a cut message has none, so they show
 * nothing of it. The typed-event path (the TUI) shows its thoughts in the reasoning channel, followed
 * by the retry's.
 *
 * ## The condition (decided on the node, not here)
 *
 * Retry only when the reply has **no answer text, no tool call and no finish reason**. A complete
 * message that says `STOP` with no text is the model's own decision and is not retried; that one
 * still reaches the runner's `runner.empty-stream` site. Usage is deliberately NOT a second signal:
 * on Vertex the real usage arrives on the same final chunk as the finish reason, so all-zero usage is
 * the same fact seen twice, and OpenAI-compatible streams without `include_usage` report zero on
 * every complete message.
 *
 * ## A second cut
 *
 * One retry is the budget. If the retry is cut too, the model call THROWS a {@link ModelStreamCutError}
 * carrying the `stream_cut` reason rather than returning the cut message:
 *
 * - returned, it would end the agent loop normally, the rating hook would rate an empty review again
 *   (issue #465's PASS 10/10), and each of the runner's three empty-turn sites would have to learn to
 *   say "cut" instead of "returned nothing";
 * - thrown, it ends the turn at the runner's existing error sites on every path, whose classifier
 *   inherits the attached reason, and the rating never runs on a review that does not exist.
 *
 * The reason is carried twice, as [[EXT-159]] asks: on the error, and on the agent through
 * `onCut`, which the runner's `getTerminationReason()` prefers.
 */
import { AIMessage } from '@langchain/core/messages';
import { MiddlewareError, createMiddleware } from 'langchain';
import { answerTextOf } from '#src/core/reasoningBlocks.js';
import { readStopReasonToken } from '#src/core/refusal.js';
import {
  attachTerminationReason,
  terminationReason,
  type GthTerminationReason,
} from '#src/core/terminationReason.js';
import { debugLog } from '#src/utils/debugUtils.js';

/** The middleware's name, which `createAgent` also gives to the error it wraps a throw in. */
export const CUT_STREAM_RETRY_MIDDLEWARE_NAME = 'GthCutStreamRetry';

/** The debug-log line written when a cut reply is retried. Stable, so a log can be counted. */
export const CUT_STREAM_RETRY_LOG = 'EXT-204 cut stream: retrying the model call once';

/** The debug-log line written when the retried reply was cut as well. */
export const CUT_STREAM_EXHAUSTED_LOG =
  'EXT-204 cut stream: the retry was cut too, ending the turn';

/** The debug-log line written when the retry came back whole. */
export const CUT_STREAM_RECOVERED_LOG = 'EXT-204 cut stream: recovered on the retry';

/**
 * Was this model reply cut off before it finished? True only for an `AIMessage` with no answer text,
 * no tool call (valid or invalid) and no stop/finish reason under any key the EXT-159 reader knows.
 *
 * Thought parts do not count as answer text ({@link answerTextOf} excludes them), which is exactly the
 * measured shape. Anything that is not an `AIMessage` — a `Command` from a structured-output retry —
 * is not a reply this module has an opinion about.
 */
export function isCutModelReply(message: unknown): boolean {
  if (!AIMessage.isInstance(message)) return false;
  if ((message.tool_calls?.length ?? 0) > 0) return false;
  if ((message.invalid_tool_calls?.length ?? 0) > 0) return false;
  if (answerTextOf(message.content).trim().length > 0) return false;
  return readStopReasonToken(message) === null;
}

/**
 * The model's reply was cut off twice in a row: the turn ends here with the `stream_cut` reason
 * attached, rather than as an empty answer.
 */
export class ModelStreamCutError extends Error {
  constructor(readonly reason: GthTerminationReason) {
    super(
      "The model's reply was cut off before it finished, and the retry was cut off too. " +
        'Sending the same request again may work.'
    );
    this.name = 'ModelStreamCutError';
    attachTerminationReason(this, reason);
  }
}

/**
 * **Adding a `wrapModelCall` layer must not move a provider error one `cause` further away.**
 *
 * `createAgent` wraps whatever a `wrapModelCall` hook throws in a `MiddlewareError` whose `cause` is
 * the thrown value, at EVERY layer. So a provider error thrown under this middleware would reach the
 * graph wrapped twice — once by the inner layer, once by this one — where it was wrapped once before
 * this layer existed. Readers that look exactly one `cause` deep ({@link terminationReasonOf}, the
 * context-overflow seam's `ContextOverflowError` check) would stop seeing it. Measured: the EXT-160
 * spec's "the error is re-thrown unchanged" cell went red when this layer was added without this.
 *
 * So the one wrap the inner layer added is taken off before this layer's own wrap goes on, and the
 * error the rest of the runtime sees has the shape it had before. A `MiddlewareError` keeps the
 * original's `name` and `message`, so nothing else about it changes. Anything that is not a
 * `MiddlewareError` (an interrupt, which `createAgent` never wraps) passes through as it came.
 */
function withoutInnerMiddlewareWrap(error: unknown): unknown {
  if (MiddlewareError.isInstance(error) && (error as { cause?: unknown }).cause !== undefined) {
    return (error as { cause?: unknown }).cause;
  }
  return error;
}

/**
 * Build the retry middleware. See the module comment for the argument.
 *
 * @param onCut Records the `stream_cut` reason on the agent when the retry is cut as well. Called
 *   before the throw, so the agent's first-write-wins record holds it whatever a later site notes.
 */
export function createCutStreamRetryMiddleware(onCut?: (reason: GthTerminationReason) => void) {
  return createMiddleware({
    name: CUT_STREAM_RETRY_MIDDLEWARE_NAME,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapModelCall: async (request: any, handler: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const call = async (): Promise<any> => {
        try {
          return await handler(request);
        } catch (error) {
          throw withoutInnerMiddlewareWrap(error);
        }
      };
      const first = await call();
      if (!isCutModelReply(first)) return first;
      // Esc stopped this call: an aborted stream also ends without a finish reason, and retrying it
      // would override the one thing the user asked for.
      if (request?.runtime?.signal?.aborted) return first;
      debugLog(CUT_STREAM_RETRY_LOG);
      const second = await call();
      if (!isCutModelReply(second)) {
        debugLog(CUT_STREAM_RECOVERED_LOG);
        return second;
      }
      if (request?.runtime?.signal?.aborted) return second;
      debugLog(CUT_STREAM_EXHAUSTED_LOG);
      const reason = terminationReason('middleware.stream-cut-retry', 'control', 'stream_cut');
      try {
        onCut?.(reason);
      } catch {
        /* recording why a run ended must never be what ends it differently */
      }
      throw new ModelStreamCutError(reason);
    },
  });
}
