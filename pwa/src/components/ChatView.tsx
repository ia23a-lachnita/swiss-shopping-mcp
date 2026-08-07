import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from 'ai';
import { Drawer } from 'vaul';
import {
  AlertTriangle,
  History,
  MapPin,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';

import { CHAIN_LABELS, type Chain, type Product } from '../api';
import {
  deleteConversation,
  listConversations,
  loadActiveLocation,
  loadConversation,
  newConversationId,
  requestPersistentStorage,
  saveActiveLocation,
  saveConversation,
  titleFromMessages,
  type Conversation,
  type ConversationSummary,
} from '../lib/chatHistory';
import { cn } from '../lib/utils';
import { ProductSheet } from './ProductSheet';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Price } from './ui/price';
import { Skeleton } from './ui/skeleton';

// Tool result shapes, as returned by src/agent/tools.ts (mirrors the server's
// normalized contract — same convention as api.ts's other mirrored types).
interface CompareToolOutput {
  comparison?: {
    query: string;
    offers: Array<{ chain: Chain; product: Product; effectivePrice: number; totalPrice: number }>;
    cheapestOffer?: { chain: Chain; effectivePrice: number };
  };
  error?: { code?: string; message?: string };
}
interface StoresToolOutput {
  stores?: Array<{ id: string; chain: Chain; name: string; address: string; openingHours?: string }>;
  error?: { code?: string; message?: string };
}

/**
 * Mirrors the tag openers the server salvages (src/agent/textToolCall.ts).
 * Whatever the model emits, tool-call syntax is never shown to a user as an
 * answer: on 2026-08-04 a `<tool_call>` template rendered verbatim as the
 * assistant's reply. The server recovers what it can; this is the backstop for
 * what it cannot.
 */
const TOOL_CALL_SYNTAX = /<tool_call|<function_call|<function=/;

function looksLikeToolCallSyntax(text: string): boolean {
  return TOOL_CALL_SYNTAX.test(text);
}

/**
 * The chat transport throws with the raw response body, so a server error
 * arrives here as the whole `{"ok":false,"error":{…}}` envelope. Show the
 * sentence inside it — a shopper who is rate-limited should read "in 34s
 * wieder versuchen", not a JSON blob.
 */
function readableError(error: Error): string {
  try {
    const parsed: unknown = JSON.parse(error.message);
    const message = (parsed as { error?: { message?: string } })?.error?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  } catch {
    // not JSON — the message is already prose
  }
  return error.message;
}

/** Anything the user can actually read: prose, or a tool card with a result. */
function hasRenderableContent(message: UIMessage): boolean {
  return message.parts.some((part) => {
    if (part.type === 'text') {
      return part.text.trim().length > 0 && !looksLikeToolCallSyntax(part.text);
    }
    return isToolUIPart(part) && (part.state === 'output-available' || part.state === 'output-error');
  });
}

function ToolLoadingPill({ toolName }: { toolName: string }): React.JSX.Element {
  const icon =
    toolName === 'find_stores' ? (
      <MapPin className="size-3.5 animate-pulse" />
    ) : toolName === 'compare_prices' ? (
      <Scale className="size-3.5 animate-pulse" />
    ) : (
      <Search className="size-3.5 animate-pulse" />
    );
  return (
    <div className="flex items-center gap-1.5 text-xs text-faint">
      {icon} Suche läuft ({toolName})…
    </div>
  );
}

function ToolErrorNote({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 rounded-card bg-danger-bg px-3 py-2 text-xs text-danger">
      <AlertTriangle className="size-3.5 shrink-0" /> {message}
    </div>
  );
}

function ProductResultList({
  products,
  onSelect,
}: {
  products: Array<Product & { title?: string }>;
  onSelect: (product: Product) => void;
}): React.JSX.Element {
  if (products.length === 0) {
    return <p className="text-xs text-faint">Keine Treffer.</p>;
  }
  return (
    <ul className="grid grid-cols-2 gap-2">
      {products.slice(0, 8).map((product) => (
        <li key={`${product.chain}:${product.id}`}>
          <button
            type="button"
            onClick={() => onSelect(product)}
            className="flex w-full flex-col gap-1 rounded-card bg-surface p-2.5 text-left shadow-card"
          >
            <span className="flex items-center gap-1">
              <Badge className="text-[0.6rem]">{CHAIN_LABELS[product.chain]}</Badge>
              {product.promotionLabel && (
                <Badge variant="promo" className="text-[0.6rem]">
                  {product.promotionLabel}
                </Badge>
              )}
            </span>
            <span className="truncate text-xs font-semibold">{product.title ?? product.name}</span>
            <Price value={product.price.current} className="text-xs font-semibold text-ink" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function CompareResultList({ output, onSelect }: { output: CompareToolOutput; onSelect: (p: Product) => void }): React.JSX.Element {
  const offers = output.comparison?.offers ?? [];
  if (offers.length === 0) {
    return <p className="text-xs text-faint">Keine vergleichbaren Angebote gefunden.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {offers.slice(0, 8).map((offer) => (
        <li key={`${offer.chain}:${offer.product.id}`}>
          <button
            type="button"
            onClick={() => onSelect(offer.product)}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-card px-3 py-2 text-left text-xs shadow-card',
              offer.chain === output.comparison?.cheapestOffer?.chain ? 'bg-success-bg' : 'bg-surface'
            )}
          >
            <span className="flex items-center gap-1.5 truncate">
              <Badge className="shrink-0 text-[0.6rem]">{CHAIN_LABELS[offer.chain]}</Badge>
              <span className="truncate">{offer.product.name}</span>
            </span>
            <Price value={offer.totalPrice} className="shrink-0 font-semibold text-ink" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function StoresResultList({ output }: { output: StoresToolOutput }): React.JSX.Element {
  const stores = output.stores ?? [];
  if (stores.length === 0) {
    return <p className="text-xs text-faint">Keine Filialen gefunden.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {stores.slice(0, 6).map((store) => (
        <li key={`${store.chain}:${store.id}`} className="rounded-card bg-surface px-3 py-2 text-xs shadow-card">
          <span className="flex items-center gap-1.5">
            <Badge className="text-[0.6rem]">{CHAIN_LABELS[store.chain]}</Badge>
            <span className="font-semibold">{store.name}</span>
          </span>
          <p className="mt-0.5 text-faint">{store.address}</p>
        </li>
      ))}
    </ul>
  );
}

function ToolResultCard({
  toolName,
  output,
  errorText,
  onSelectProduct,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
  onSelectProduct: (p: Product) => void;
}): React.JSX.Element | null {
  if (errorText) {
    return <ToolErrorNote message={errorText} />;
  }
  const payload = (output ?? {}) as Record<string, unknown>;
  if (payload.error) {
    const err = payload.error as { message?: string };
    return <ToolErrorNote message={err.message ?? 'Werkzeugaufruf fehlgeschlagen.'} />;
  }

  if (toolName === 'search_products' && Array.isArray(payload.products)) {
    return <ProductResultList products={payload.products as Product[]} onSelect={onSelectProduct} />;
  }
  if (toolName === 'search_promotions' && Array.isArray(payload.promotions)) {
    return <ProductResultList products={payload.promotions as Product[]} onSelect={onSelectProduct} />;
  }
  if (toolName === 'compare_prices') {
    return <CompareResultList output={payload as CompareToolOutput} onSelect={onSelectProduct} />;
  }
  if (toolName === 'find_stores') {
    return <StoresResultList output={payload as StoresToolOutput} />;
  }
  // Other tools (availability support, source status, metrics) — a minimal
  // grounding marker rather than a bespoke card, still visually distinct from prose.
  return (
    <p className="flex items-center gap-1.5 text-xs text-faint">
      <Sparkles className="size-3" /> {toolName} — Ergebnis erhalten.
    </p>
  );
}

function MessageBubble({
  message,
  onSelectProduct,
}: {
  message: UIMessage;
  onSelectProduct: (p: Product) => void;
}): React.JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex flex-col gap-2', isUser ? 'items-end' : 'items-start')}>
      {message.parts.map((part, index) => {
        if (part.type === 'text' && part.text.trim().length > 0) {
          if (!isUser && looksLikeToolCallSyntax(part.text)) {
            return (
              <div key={index} className="w-full max-w-[95%]">
                <ToolErrorNote message="Das Modell hat einen Werkzeugaufruf als Text geschrieben statt ihn auszuführen — die Antwort ist unbrauchbar." />
              </div>
            );
          }
          return (
            <div
              key={index}
              className={cn(
                'max-w-[85%] rounded-card px-3.5 py-2.5 text-sm shadow-card',
                isUser ? 'bg-brand text-brand-ink' : 'bg-surface text-ink'
              )}
            >
              {part.text}
            </div>
          );
        }
        if (isToolUIPart(part)) {
          const toolName = getToolName(part);
          if (part.state === 'input-streaming' || part.state === 'input-available') {
            return (
              <div key={index} className="max-w-[85%]">
                <ToolLoadingPill toolName={toolName} />
              </div>
            );
          }
          if (part.state === 'output-available' || part.state === 'output-error') {
            return (
              <div key={index} className="w-full max-w-[95%]">
                <ToolResultCard
                  toolName={toolName}
                  output={'output' in part ? part.output : undefined}
                  errorText={'errorText' in part ? part.errorText : undefined}
                  onSelectProduct={onSelectProduct}
                />
              </div>
            );
          }
        }
        return null;
      })}
    </div>
  );
}

const SUGGESTIONS = [
  '2x Milch, Zahnpasta, 500g Rindshackfleisch',
  'Wo ist Bio-Reis am günstigsten?',
  'Migros Filiale in Zürich',
];

/** Debounced like `queryPersist.ts`'s cache mirror, and for the same reason. */
const WRITE_DEBOUNCE_MS = 1_000;

/**
 * The active conversation is mirrored into `?c=` — the same place, and for the
 * same reasons, `useTabState` keeps the active tab: a reload resumes the thread
 * the user was in, and Android's back button walks back through conversations
 * instead of closing an installed PWA. It is tab-scoped by construction, where
 * a pointer record in IndexedDB would make two windows fight over one "active"
 * id and would force a second async read before the first paint.
 */
function conversationIdFromUrl(): string | undefined {
  return new URLSearchParams(window.location.search).get('c') ?? undefined;
}

function pushConversationIdToUrl(id: string): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get('c') === id) return;
  url.searchParams.set('c', id);
  window.history.pushState(null, '', url);
}

function formatConversationDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function ConversationHistorySheet({
  open,
  onOpenChange,
  summaries,
  activeId,
  onSelect,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summaries: ConversationSummary[];
  activeId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] max-w-2xl flex-col rounded-t-3xl bg-surface outline-none">
          <div className="mx-auto mt-3 h-1.5 w-10 shrink-0 rounded-full bg-line" />
          <div
            className="min-h-0 flex-1 overflow-y-auto p-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]"
            data-testid="chat-history-sheet"
          >
            <Drawer.Title className="text-lg font-semibold">Verlauf</Drawer.Title>
            {summaries.length === 0 ? (
              <p className="mt-3 text-sm text-muted">Noch keine gespeicherten Unterhaltungen.</p>
            ) : (
              <ul className="mt-3 space-y-1">
                {summaries.map((summary) => (
                  <li
                    key={summary.id}
                    data-testid="chat-history-item"
                    className={cn(
                      'flex items-center gap-1 rounded-card px-1',
                      summary.id === activeId && 'bg-surface-sunken'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(summary.id)}
                      className="min-w-0 flex-1 py-2.5 text-left"
                    >
                      <span className="block truncate text-sm text-ink">{summary.title}</span>
                      <span className="block text-xs text-faint">
                        {formatConversationDate(summary.updatedAt)} · {summary.messageCount} Nachrichten
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(summary.id)}
                      aria-label={`${summary.title} löschen`}
                      className="shrink-0 rounded-lg p-2 text-faint active:bg-surface-sunken"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export function ChatView(): React.JSX.Element {
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [conversationId, setConversationId] = useState('');
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [initialActiveLocation, setInitialActiveLocation] = useState<string | undefined>();

  const refreshSummaries = useCallback(async (): Promise<void> => {
    setSummaries(await listConversations());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot(): Promise<void> {
      void requestPersistentStorage();
      const [list, location] = await Promise.all([listConversations(), loadActiveLocation()]);
      // `?c=` wins when it names a conversation that still exists; otherwise
      // resume the most recently updated one, which is what a cold launch of an
      // installed PWA (no query string at all) always hits.
      const requested = conversationIdFromUrl();
      const targetId = requested && list.some((s) => s.id === requested) ? requested : list[0]?.id;
      const target = targetId ? await loadConversation(targetId) : undefined;
      if (cancelled) return;
      setSummaries(list);
      setInitialActiveLocation(location);
      setConversation(target);
      setConversationId(target?.id ?? newConversationId());
      setHistoryLoaded(true);
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const openConversation = useCallback(
    async (id: string | undefined): Promise<void> => {
      const target = id ? await loadConversation(id) : undefined;
      const nextId = target?.id ?? newConversationId();
      setConversation(target);
      setConversationId(nextId);
      pushConversationIdToUrl(nextId);
      await refreshSummaries();
    },
    [refreshSummaries]
  );

  useEffect(() => {
    function handlePopState(): void {
      const id = conversationIdFromUrl();
      if (!id || id === conversationId) return;
      void loadConversation(id).then((target) => {
        setConversation(target);
        setConversationId(target?.id ?? id);
      });
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [conversationId]);

  const removeConversation = useCallback(
    async (id: string): Promise<void> => {
      await deleteConversation(id);
      const list = await listConversations();
      setSummaries(list);
      if (id === conversationId) {
        await openConversation(list[0]?.id);
      }
    },
    [conversationId, openConversation]
  );

  if (!historyLoaded) {
    return (
      <div className="space-y-3 pt-3">
        <Skeleton className="h-16 w-3/4 rounded-card" />
        <Skeleton className="ml-auto h-10 w-1/2 rounded-card" />
      </div>
    );
  }

  return (
    // Remounting on `conversationId` is what swaps the thread: `useChat` seeds
    // its state from `messages` once, so switching without a new key would keep
    // the previous conversation's messages on screen.
    <ChatConversation
      key={conversationId}
      conversationId={conversationId}
      conversation={conversation}
      initialActiveLocation={initialActiveLocation}
      summaries={summaries}
      onRefreshSummaries={refreshSummaries}
      onOpenConversation={openConversation}
      onDeleteConversation={removeConversation}
    />
  );
}

function ChatConversation({
  conversationId,
  conversation,
  initialActiveLocation,
  summaries,
  onRefreshSummaries,
  onOpenConversation,
  onDeleteConversation,
}: {
  conversationId: string;
  conversation: Conversation | undefined;
  initialActiveLocation: string | undefined;
  summaries: ConversationSummary[];
  onRefreshSummaries: () => Promise<void>;
  onOpenConversation: (id: string | undefined) => Promise<void>;
  onDeleteConversation: (id: string) => Promise<void>;
}): React.JSX.Element {
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState<Product | undefined>();
  const [activeLocation, setActiveLocation] = useState<string | undefined>(initialActiveLocation);
  const [historyOpen, setHistoryOpen] = useState(false);
  const listEndRef = useRef<HTMLDivElement>(null);

  const [turnFailed, setTurnFailed] = useState(false);
  const initialMessages = conversation?.messages ?? [];
  const { messages, sendMessage, regenerate, status, error, stop } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: activeLocation ? { activeLocation } : {},
    }),
  });

  // Identity of the array already on disk. `useChat` hands back a new array on
  // every change, so identity is a sound "has anything changed" test — and it
  // is what stops merely *opening* an old conversation from bumping its
  // `updatedAt` and reshuffling the history list.
  const persistedRef = useRef<UIMessage[]>(initialMessages);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const metaRef = useRef({
    createdAt: conversation?.createdAt ?? Date.now(),
    title: conversation?.title ?? '',
  });
  const abandonedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const persist = useCallback((): void => {
    const current = messagesRef.current;
    // An empty thread is deliberately never written: a "new chat" the user
    // never spoke to must not appear in the history sheet as a blank row.
    if (abandonedRef.current || current.length === 0 || current === persistedRef.current) return;
    if (!metaRef.current.title) metaRef.current.title = titleFromMessages(current);
    persistedRef.current = current;
    void saveConversation({
      id: conversationId,
      title: metaRef.current.title,
      createdAt: metaRef.current.createdAt,
      updatedAt: Date.now(),
      messages: current,
    });
  }, [conversationId]);

  useEffect(() => {
    if (messages === persistedRef.current || messages.length === 0) return;
    timerRef.current = setTimeout(persist, WRITE_DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [messages, persist]);

  // The debounce's trailing edge never arrives if the OS suspends the tab
  // first, which on a phone is an ordinary way for a chat to end.
  // `visibilitychange` to hidden is the last callback a page is reliably given
  // (Page Lifecycle API), so flush there rather than on `unload`.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    function handleVisibility(): void {
      if (document.visibilityState !== 'hidden') return;
      clearTimeout(timerRef.current);
      persistRef.current();
    }
    document.addEventListener('visibilitychange', handleVisibility);
    // Switching conversations unmounts this component; flush whatever the
    // debounce was still holding rather than dropping it.
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      persistRef.current();
    };
  }, []);

  /**
   * Leaving this thread — switching, starting a new one, or deleting it. Stops
   * the stream first: an in-flight response keeps updating `messages` after the
   * component is gone otherwise, and the pending debounce would write the
   * conversation back out, resurrecting a record the user just deleted.
   */
  function leave(): void {
    stop();
    clearTimeout(timerRef.current);
  }

  function selectConversation(id: string): void {
    if (id === conversationId) {
      setHistoryOpen(false);
      return;
    }
    leave();
    persist();
    setHistoryOpen(false);
    void onOpenConversation(id);
  }

  function startNewConversation(): void {
    leave();
    persist();
    setHistoryOpen(false);
    void onOpenConversation(undefined);
  }

  function removeConversation(id: string): void {
    if (id === conversationId) {
      leave();
      abandonedRef.current = true;
    }
    setHistoryOpen(false);
    void onDeleteConversation(id);
  }

  // Watch the tool-part stream for `set_chat_location` reaching
  // `output-available` — the newest call across the whole conversation wins.
  useEffect(() => {
    let latest: string | undefined;
    for (const message of messages) {
      for (const part of message.parts) {
        if (isToolUIPart(part) && getToolName(part) === 'set_chat_location' && part.state === 'output-available') {
          const output = 'output' in part ? (part.output as { location?: string } | undefined) : undefined;
          if (output?.location) {
            latest = output.location;
          }
        }
      }
    }
    if (latest && latest !== activeLocation) {
      setActiveLocation(latest);
      void saveActiveLocation(latest);
    }
  }, [messages, activeLocation]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';

  // A turn that produces nothing readable used to end by simply removing the
  // "denkt nach…" indicator, which is indistinguishable from a crash — the
  // reported reaction was to type "hello?" into the void. Watch the
  // busy → idle transition and say plainly that the turn failed, with a way
  // to retry. `status === 'error'` keeps its own message below.
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status === 'submitted' || status === 'streaming') {
      setTurnFailed(false);
      return;
    }
    if (status === 'ready' && (previous === 'submitted' || previous === 'streaming')) {
      const last = messages[messages.length - 1];
      setTurnFailed(last === undefined || last.role !== 'assistant' || !hasRenderableContent(last));
    }
  }, [status, messages]);

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void sendMessage({ text });
    setInput('');
  }

  return (
    // Sized to exactly the space between header and nav so the composer can be
    // a normal flex child pinned at the bottom. It was previously `sticky`
    // sitting in page flow after the message list, which only pins once the
    // page scrolls — with a short conversation it just sat under the last
    // message with a large empty gap beneath it, drifting down as the chat grew.
    <div className="flex h-[calc(100dvh-var(--header-h,3.25rem)-var(--nav-clearance))] flex-col">
      {/* The plan put these in the app header, but that header is global chrome
          shared by all five tabs (App.tsx) and carries the product title; a
          chat-only control there would have to be conditioned on the active
          tab. A toolbar row inside the chat keeps the concern where it belongs
          and costs one `shrink-0` line of the height budget. */}
      <div className="flex shrink-0 items-center justify-between gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void onRefreshSummaries();
            setHistoryOpen(true);
          }}
          data-testid="chat-history-open"
        >
          <History /> Verlauf
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={startNewConversation}
          disabled={messages.length === 0}
          data-testid="chat-new-conversation"
        >
          <Plus /> Neu
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-3">
        {messages.length === 0 && (
          <div className="space-y-3 rounded-card bg-surface p-4 shadow-card">
            <p className="text-sm text-muted">
              Frag mich nach Produkten, Preisen oder Filialen — oder schick mir gleich eine ganze
              Einkaufsliste.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setInput(s)}
                  className="rounded-full bg-surface-sunken px-3 py-1.5 text-xs text-muted shadow-inset"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} onSelectProduct={setSelected} />
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 text-xs text-faint">
            <Sparkles className="size-3.5 animate-pulse" /> denkt nach…
          </div>
        )}
        {error && !busy && (
          <div className="space-y-2" data-testid="chat-error">
            <ToolErrorNote message={readableError(error)} />
            <Button type="button" variant="outline" size="sm" onClick={() => void regenerate()}>
              <RefreshCw /> Nochmal versuchen
            </Button>
          </div>
        )}
        {turnFailed && !busy && !error && (
          <div className="space-y-2" data-testid="chat-turn-failed">
            <ToolErrorNote message="Keine Antwort erhalten — die Anfrage ist ohne Ergebnis geendet." />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setTurnFailed(false);
                void regenerate();
              }}
            >
              <RefreshCw /> Nochmal versuchen
            </Button>
          </div>
        )}
        <div ref={listEndRef} />
      </div>

      <div className="shrink-0 pt-3">
        <form
          onSubmit={submit}
          className="flex items-center gap-2 rounded-card bg-surface p-2 shadow-card-lg"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Frag etwas oder füg eine Einkaufsliste ein…"
            className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-faint"
            enterKeyHint="send"
          />
          <Button type="submit" size="icon" disabled={!input.trim() || busy} aria-label="Senden">
            <Send className="size-4" />
          </Button>
        </form>

        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => removeConversation(conversationId)}
            className="mx-auto mt-2 block text-xs text-faint underline"
            data-testid="chat-delete-current"
          >
            Unterhaltung löschen
          </button>
        )}
      </div>

      <ConversationHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        summaries={summaries}
        activeId={conversationId}
        onSelect={selectConversation}
        onDelete={removeConversation}
      />
      <ProductSheet product={selected} onClose={() => setSelected(undefined)} />
    </div>
  );
}
