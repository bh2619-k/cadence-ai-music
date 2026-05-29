import { trpc } from "@/utils/trpc";
import { Paywall } from "@/components/Paywall";

/**
 * Shows the user's live credit balance (React Query via tRPC) and, when the
 * balance hits zero, renders the experiment-gated paywall in place — the exact
 * "fire the prompt at the moment of exhaustion" surface.
 */
export function CreditMeter() {
  const balance = trpc.credits.getBalance.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });

  if (balance.isLoading) return <div className="muted">Loading credits…</div>;
  if (balance.error) return <div className="muted">Couldn&apos;t load credits.</div>;

  const { balance: credits, dailyAllowance } = balance.data;

  return (
    <div>
      <div className="card">
        <strong>{credits}</strong> credits
        <span className="muted"> · {dailyAllowance}/day</span>
      </div>
      {credits <= 0 ? <Paywall trigger="credit_exhausted" /> : null}
    </div>
  );
}
