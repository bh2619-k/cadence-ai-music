import { trpc } from "@/utils/trpc";

export default function Billing() {
  const sub = trpc.billing.getSubscription.useQuery();
  const history = trpc.credits.history.useQuery({ limit: 20 });
  const portal = trpc.billing.createPortal.useMutation({
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  return (
    <main className="container">
      <h1>Billing</h1>

      <div className="card">
        {sub.isLoading ? (
          "Loading…"
        ) : sub.data ? (
          <>
            <div>
              Plan: <strong>{sub.data.plan.name}</strong>
            </div>
            <div>Status: {sub.data.status}</div>
            {sub.data.currentPeriodEnd ? (
              <div className="muted">
                Renews {new Date(sub.data.currentPeriodEnd).toLocaleDateString()}
                {sub.data.cancelAtPeriodEnd ? " (cancels at period end)" : ""}
              </div>
            ) : null}
            <div style={{ marginTop: 12 }}>
              <button
                className="btn"
                disabled={portal.isLoading}
                onClick={() => portal.mutate()}
              >
                Manage billing
              </button>
            </div>
          </>
        ) : (
          <div>
            No active subscription. <a href="/pricing">See plans</a>
          </div>
        )}
      </div>

      <h2>Credit history</h2>
      <div className="card">
        {history.data?.length ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th align="left">When</th>
                <th align="left">Reason</th>
                <th align="right">Δ</th>
                <th align="right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{row.reason}</td>
                  <td align="right">
                    {row.delta > 0 ? `+${row.delta}` : row.delta}
                  </td>
                  <td align="right">{row.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="muted">No activity yet.</span>
        )}
      </div>
    </main>
  );
}
