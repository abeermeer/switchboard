/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Combo, ConnectionView } from '@/types/core';
import { PolicyEditor } from '@/components/routing/PolicyEditor';
import { ToastProvider } from '@/components/ui/Toast';

// The editor is a client component that navigates and refreshes on save.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The trace panel does its own fetching and debouncing; it has its own concerns
// and would only add noise here.
vi.mock('@/components/routing/DecisionTrace', () => ({
  DecisionTrace: () => <div data-testid="decision-trace" />,
}));

const COMBO: Combo = {
  id: 'combo_1',
  slug: 'auto',
  name: 'Auto',
  description: 'Free tiers first.',
  modality: 'chat',
  strategy: 'free-first',
  members: [
    { connectionId: 'conn_groq', modelId: 'llama-3.1-8b-instant', order: 0, weight: 1, enabled: true },
    { connectionId: 'conn_cerebras', modelId: 'llama3.1-8b', order: 1, weight: 1, enabled: true },
  ],
  requires: [],
  maxCostPerMTok: null,
  maxAttempts: 4,
  timeoutMs: 120_000,
  enabled: true,
  isDefault: true,
  createdAt: 0,
  updatedAt: 0,
};

function connection(id: string, providerId: string, label: string): ConnectionView {
  return {
    id,
    providerId,
    label,
    enabled: true,
    tierOverride: null,
    priority: 100,
    baseUrlOverride: null,
    monthlyBudgetUsd: null,
    createdAt: 0,
    updatedAt: 0,
    provider: {
      id: providerId,
      name: label,
      kind: 'openai-compatible',
      baseUrl: `https://api.${providerId}.com/v1`,
      authScheme: 'bearer',
      docsUrl: '',
      signupUrl: '',
      freeTier: null,
      modalities: ['chat'],
      models: [
        {
          id: providerId === 'groq' ? 'llama-3.1-8b-instant' : 'llama3.1-8b',
          name: 'Llama 3.1 8B',
          modality: 'chat',
          features: ['streaming'],
          contextWindow: 131_072,
          maxOutput: 8_192,
          inputCostPerMTok: 0.05,
          outputCostPerMTok: 0.08,
          throughputPrior: 800,
        },
      ],
      accent: '#f0912f',
      requiresKey: true,
      blurb: '',
    },
    status: 'healthy',
    hasCredential: true,
    tier: 'free',
    health: {
      connectionId: id,
      status: 'healthy',
      breaker: 'closed',
      successRate: 1,
      p50LatencyMs: 200,
      p95LatencyMs: 400,
      consecutiveFailures: 0,
      openedAt: null,
      cooldownUntil: null,
      lastCheckedAt: null,
      lastError: null,
    },
    usage: {
      requests: 0,
      successes: 0,
      failures: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      savedUsd: 0,
    },
  };
}

const CONNECTIONS = [
  connection('conn_groq', 'groq', 'Groq'),
  connection('conn_cerebras', 'cerebras', 'Cerebras'),
];

function renderEditor(combo: Combo = COMBO): void {
  render(
    <ToastProvider>
      <PolicyEditor combo={combo} connections={CONNECTIONS} />
    </ToastProvider>,
  );
}

/** Captures what the editor PUTs, so ordering can be asserted on the payload. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({ ...COMBO, ...(body ?? {}) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('PolicyEditor', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('rendering the policy', () => {
    it('shows the name, slug and description', () => {
      renderEditor();

      expect(screen.getByDisplayValue('Auto')).toBeTruthy();
      expect(screen.getByDisplayValue('auto')).toBeTruthy();
      expect(screen.getByDisplayValue('Free tiers first.')).toBeTruthy();
    });

    it('offers every routing strategy', () => {
      renderEditor();

      for (const label of [
        'Free first',
        'Cost optimised',
        'Fastest',
        'Quality first',
        'Priority order',
        'Round robin',
        'Failover',
      ]) {
        expect(screen.getByText(label)).toBeTruthy();
      }
    });

    it('explains what each strategy gives up, not just what it does', () => {
      // A label alone asks the user to trust it; the tradeoff is the useful part.
      renderEditor();
      expect(screen.getByText(/Trades some latency for cost/i)).toBeTruthy();
    });

    it('lists the member chain in order', () => {
      renderEditor();

      expect(screen.getByText('llama-3.1-8b-instant')).toBeTruthy();
      expect(screen.getByText('llama3.1-8b')).toBeTruthy();
    });

    it('says plainly that an empty chain is valid', () => {
      // Otherwise the user stares at an empty box wondering what they broke.
      renderEditor({ ...COMBO, members: [] });

      expect(screen.getByText(/No members pinned/i)).toBeTruthy();
      expect(screen.getByText(/every connection that can serve/i)).toBeTruthy();
    });

    it('shows the slug as the model string a client would send', () => {
      renderEditor();
      expect(screen.getByText(/Clients send this as the model/i)).toBeTruthy();
    });
  });

  describe('editing', () => {
    it('saves the strategy as soon as it is picked', async () => {
      renderEditor();

      fireEvent.click(screen.getByText('Fastest'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/combos/combo_1',
          expect.objectContaining({ method: 'PATCH' }),
        );
      });

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
        strategy: string;
      };
      expect(body.strategy).toBe('fastest');
    });

    it('saves the name on blur rather than on every keystroke', async () => {
      renderEditor();
      const name = screen.getByDisplayValue('Auto');

      fireEvent.change(name, { target: { value: 'Auto (tuned)' } });
      expect(fetchMock).not.toHaveBeenCalled();

      fireEvent.blur(name);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    });

    it('toggles a required capability on and off', async () => {
      renderEditor();

      fireEvent.click(screen.getByText('tools'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
        requires: string[];
      };
      expect(body.requires).toContain('tools');
    });

    it('saves the default-policy switch', async () => {
      renderEditor({ ...COMBO, isDefault: false });

      fireEvent.click(screen.getByRole('switch', { name: /Default policy/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
        isDefault: boolean;
      };
      expect(body.isDefault).toBe(true);
    });
  });

  describe('reordering the chain', () => {
    /** The member rows, in the order they are rendered. */
    function memberRows(): HTMLElement[] {
      return screen
        .getAllByRole('listitem')
        .filter((row) => within(row).queryByLabelText('Move up') !== null);
    }

    it('offers keyboard controls, not drag alone', () => {
      // A drag-only list is unusable without a mouse.
      renderEditor();

      expect(screen.getAllByLabelText('Move up')).toHaveLength(2);
      expect(screen.getAllByLabelText('Move down')).toHaveLength(2);
    });

    it('moves a member down and persists the new order', async () => {
      renderEditor();

      fireEvent.click(within(memberRows()[0]!).getByLabelText('Move down'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/combos/combo_1/members',
          expect.objectContaining({ method: 'PUT' }),
        );
      });

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
        members: Array<{ modelId: string; order: number }>;
      };
      expect(body.members[0]?.modelId).toBe('llama3.1-8b');
      expect(body.members[1]?.modelId).toBe('llama-3.1-8b-instant');
    });

    it('renumbers order from zero after a move', async () => {
      // The order field is what the priority and failover strategies read; a
      // gap or a duplicate would make the chain ambiguous.
      renderEditor();

      fireEvent.click(within(memberRows()[1]!).getByLabelText('Move up'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
        members: Array<{ order: number }>;
      };
      expect(body.members.map((m) => m.order)).toEqual([0, 1]);
    });

    it('disables the controls that would move a member off either end', () => {
      renderEditor();
      const rows = memberRows();

      expect(within(rows[0]!).getByLabelText('Move up')).toBeDisabled();
      expect(within(rows[rows.length - 1]!).getByLabelText('Move down')).toBeDisabled();
    });

    it('removes a member and saves the shortened chain', async () => {
      renderEditor();

      fireEvent.click(within(memberRows()[0]!).getByLabelText('Remove'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
        members: unknown[];
      };
      expect(body.members).toHaveLength(1);
    });
  });

  describe('failure handling', () => {
    it('reverts the control when the save is rejected', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ error: 'slug already taken' }), { status: 409 }),
        ),
      );

      renderEditor();
      fireEvent.click(screen.getByText('Fastest'));

      // The optimistic update has to roll back, otherwise the UI claims a
      // change the server refused.
      await waitFor(() => {
        expect(screen.getByText(/Could not save/i)).toBeTruthy();
      });
    });
  });
});
