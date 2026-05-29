import Link from "next/link";
import { useSession, signIn } from "next-auth/react";
import { CreditMeter } from "@/components/CreditMeter";

export default function Home() {
  const { data: session, status } = useSession();

  return (
    <main className="container">
      <h1>Cadence</h1>
      <p className="muted">
        AI music — generate tracks, convert voices, split stems, make videos.
      </p>

      {status === "loading" ? null : session ? (
        <>
          <p>Signed in as {session.user.email}</p>
          <CreditMeter />
          <div className="row">
            <Link className="btn" href="/studio">
              Open Studio
            </Link>
            <Link className="btn secondary" href="/pricing">
              Pricing
            </Link>
            <Link className="btn secondary" href="/billing">
              Billing
            </Link>
          </div>
        </>
      ) : (
        <button className="btn" onClick={() => signIn()}>
          Sign in
        </button>
      )}
    </main>
  );
}
