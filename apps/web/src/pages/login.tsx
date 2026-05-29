import { useState } from "react";
import { signIn } from "next-auth/react";

export default function Login() {
  const [email, setEmail] = useState("");

  return (
    <main className="container">
      <h1>Sign in to Cadence</h1>

      <button
        className="btn"
        onClick={() => signIn("google", { callbackUrl: "/" })}
      >
        Continue with Google
      </button>

      <div className="card">
        <p>Or get a magic link by email:</p>
        <div className="row">
          <input
            type="email"
            value={email}
            placeholder="you@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            className="btn"
            disabled={!email}
            onClick={() => signIn("email", { email, callbackUrl: "/" })}
          >
            Email me a link
          </button>
        </div>
      </div>
    </main>
  );
}
