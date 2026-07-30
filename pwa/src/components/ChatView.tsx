import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from 'ai';
import { AlertTriangle, MapPin, Scale, Search, Send, Sparkles } from 'lucide-react';

import { CHAIN_LABELS, type Chain, type Product } from '../api';
import {
  clearChatHistory,
  loadActiveLocation,
  loadChatHistory,
  saveActiveLocation,
  saveChatHistory,
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

export function ChatView(): React.JSX.Element {
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [initialActiveLocation, setInitialActiveLocation] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadChatHistory(), loadActiveLocation()]).then(([messages, location]) => {
      if (!cancelled) {
        setInitialMessages(messages);
        setInitialActiveLocation(location);
        setHistoryLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!historyLoaded) {
    return (
      <div className="space-y-3 pt-3">
        <Skeleton className="h-16 w-3/4 rounded-card" />
        <Skeleton className="ml-auto h-10 w-1/2 rounded-card" />
      </div>
    );
  }

  return <ChatConversation initialMessages={initialMessages} initialActiveLocation={initialActiveLocation} />;
}

function ChatConversation({
  initialMessages,
  initialActiveLocation,
}: {
  initialMessages: UIMessage[];
  initialActiveLocation: string | undefined;
}): React.JSX.Element {
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState<Product | undefined>();
  const [activeLocation, setActiveLocation] = useState<string | undefined>(initialActiveLocation);
  const listEndRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error, setMessages } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: activeLocation ? { activeLocation } : {},
    }),
  });

  useEffect(() => {
    void saveChatHistory(messages);
  }, [messages]);

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

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void sendMessage({ text });
    setInput('');
  }

  // Clearing the conversation used to `window.location.reload()`, which also
  // reset the active tab and discarded every other tab's in-memory state
  // (search/compare results). Clearing React state directly keeps the blast
  // radius to the chat, where it belongs.
  async function clearConversation(): Promise<void> {
    await clearChatHistory();
    setMessages([]);
    setActiveLocation(undefined);
  }

  return (
    // Sized to exactly the space between header and nav so the composer can be
    // a normal flex child pinned at the bottom. It was previously `sticky`
    // sitting in page flow after the message list, which only pins once the
    // page scrolls — with a short conversation it just sat under the last
    // message with a large empty gap beneath it, drifting down as the chat grew.
    <div className="flex h-[calc(100dvh-var(--header-h,3.25rem)-var(--nav-clearance))] flex-col">
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
        {error && !busy && <ToolErrorNote message={error.message} />}
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
            onClick={() => void clearConversation()}
            className="mx-auto mt-2 block text-xs text-faint underline"
          >
            Unterhaltung löschen
          </button>
        )}
      </div>

      <ProductSheet product={selected} onClose={() => setSelected(undefined)} />
    </div>
  );
}
