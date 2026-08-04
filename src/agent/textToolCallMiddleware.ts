// Turns a model's *text-form* tool call back into a real one before the AI SDK
// ever sees it as prose. See `textToolCall.ts` for the failure this exists for
// and docs/active/PWA_UX_FIX_PLAN_2026-08-04.md §5 for the field report.
//
// This has to sit at the language-model layer rather than next to
// `toolCallRepair.ts`: the repair hook is only reached once a tool call has
// been parsed, and the whole problem here is that nothing was. Rewriting the
// provider's stream is the only place the leaked text can still become a call
// that the normal loop — repair, execution, a second step — picks up unchanged.
import { randomUUID } from 'node:crypto';

import type { LanguageModelMiddleware } from 'ai';

import {
  findTriggerIndex,
  partialTriggerTailLength,
  salvageToolCallFromText,
  looksLikeToolCallSyntax,
} from './textToolCall.js';

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapStream']>>>;
type StreamPart = StreamResult extends { stream: ReadableStream<infer Part> } ? Part : never;
type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapGenerate']>>>;
type ContentPart = GenerateResult['content'][number];

function createSalvageTransform(): TransformStream<StreamPart, StreamPart> {
  /** Text withheld from the consumer: either a partial tag opener or a whole suspected call. */
  let buffer = '';
  let suspect = false;
  let textId: string | undefined;
  let openedOwnTextBlock = false;
  let salvagedAnyCall = false;

  function emitText(controller: TransformStreamDefaultController<StreamPart>, text: string): void {
    if (text.length === 0) return;
    if (textId === undefined) {
      textId = `salvage-text-${randomUUID()}`;
      openedOwnTextBlock = true;
      controller.enqueue({ type: 'text-start', id: textId } as StreamPart);
    }
    controller.enqueue({ type: 'text-delta', id: textId, delta: text } as StreamPart);
  }

  function closeOwnTextBlock(controller: TransformStreamDefaultController<StreamPart>): void {
    if (openedOwnTextBlock && textId !== undefined) {
      controller.enqueue({ type: 'text-end', id: textId } as StreamPart);
      openedOwnTextBlock = false;
      textId = undefined;
    }
  }

  /**
   * Decide what the withheld text was. Unsalvageable text is emitted as-is
   * rather than swallowed: the client refuses to render tool-call syntax as an
   * answer (ChatView), so the user gets a visible failed turn instead of a
   * turn that silently produced nothing.
   */
  function flush(controller: TransformStreamDefaultController<StreamPart>): void {
    if (buffer.length === 0) {
      suspect = false;
      return;
    }
    if (suspect) {
      const call = salvageToolCallFromText(buffer);
      if (call) {
        controller.enqueue({
          type: 'tool-call',
          toolCallId: `salvaged-${randomUUID()}`,
          toolName: call.toolName,
          input: call.input,
        } as StreamPart);
        salvagedAnyCall = true;
        buffer = '';
        suspect = false;
        return;
      }
    }
    emitText(controller, buffer);
    buffer = '';
    suspect = false;
  }

  return new TransformStream<StreamPart, StreamPart>({
    transform(part, controller): void {
      switch (part.type) {
        case 'text-start': {
          textId = part.id;
          openedOwnTextBlock = false;
          controller.enqueue(part);
          return;
        }
        case 'text-delta': {
          buffer += part.delta;
          if (!suspect) {
            const triggerIndex = findTriggerIndex(buffer);
            if (triggerIndex !== -1) {
              emitText(controller, buffer.slice(0, triggerIndex));
              buffer = buffer.slice(triggerIndex);
              suspect = true;
            } else {
              // Hold back only what could still grow into a tag opener, so
              // ordinary prose keeps streaming token by token.
              const keep = partialTriggerTailLength(buffer);
              emitText(controller, buffer.slice(0, buffer.length - keep));
              buffer = keep > 0 ? buffer.slice(buffer.length - keep) : '';
            }
          }
          return;
        }
        case 'text-end': {
          flush(controller);
          closeOwnTextBlock(controller);
          controller.enqueue(part);
          textId = undefined;
          return;
        }
        case 'finish': {
          flush(controller);
          closeOwnTextBlock(controller);
          // The provider said "stop" because, as far as it knows, it only wrote
          // text. Keep its `raw` reason and correct the unified one, so the
          // recorded step reflects what actually happened.
          controller.enqueue(
            salvagedAnyCall
              ? ({
                  ...part,
                  finishReason: { ...part.finishReason, unified: 'tool-calls' as const },
                } as StreamPart)
              : part
          );
          return;
        }
        default: {
          controller.enqueue(part);
        }
      }
    },
    flush(controller): void {
      flush(controller);
      closeOwnTextBlock(controller);
    },
  });
}

/**
 * Recovers text-form tool calls on both the streaming and non-streaming paths.
 * Well-formed responses pass through untouched — the transform only withholds
 * text once a tag opener actually appears.
 */
export const textToolCallSalvageMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',

  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    return { ...rest, stream: stream.pipeThrough(createSalvageTransform()) };
  },

  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    const leaked = result.content.filter(
      (part): part is Extract<ContentPart, { type: 'text' }> =>
        part.type === 'text' && looksLikeToolCallSyntax(part.text)
    );
    if (leaked.length === 0) return result;

    const content: ContentPart[] = [];
    let salvagedAnyCall = false;
    for (const part of result.content) {
      if (part.type !== 'text' || !looksLikeToolCallSyntax(part.text)) {
        content.push(part);
        continue;
      }
      const triggerIndex = findTriggerIndex(part.text);
      const prose = part.text.slice(0, triggerIndex);
      const call = salvageToolCallFromText(part.text.slice(triggerIndex));
      if (prose.trim().length > 0) {
        content.push({ ...part, text: prose });
      }
      if (call) {
        content.push({
          type: 'tool-call',
          toolCallId: `salvaged-${randomUUID()}`,
          toolName: call.toolName,
          input: call.input,
        } as ContentPart);
        salvagedAnyCall = true;
      } else {
        content.push(part); // unsalvageable — surfaced as a failed turn by the client
      }
    }

    return {
      ...result,
      content,
      finishReason: salvagedAnyCall
        ? { ...result.finishReason, unified: 'tool-calls' as const }
        : result.finishReason,
    };
  },
};
