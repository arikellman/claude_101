"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";

/**
 * Magic-link sign-in. Single user, so there is no sign-up flow to build.
 *
 * Extracted from page.tsx so every screen using useSession() can fall back to the same
 * component when the session is missing or has expired, instead of each page inventing
 * its own dead-end "Loading…" state.
 */
export default function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    const { error } = await browserClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="flex flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Nutrition Log</h1>
      {sent ? (
        <p className="text-sm text-neutral-400">
          Check {email} for a sign-in link.
        </p>
      ) : (
        <>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="rounded-2xl border border-ink-line bg-ink-soft p-4
                       focus:border-neutral-500 focus:outline-none"
          />
          <button
            onClick={send}
            disabled={!email.includes("@")}
            className="rounded-2xl bg-neutral-100 py-4 font-semibold text-ink disabled:opacity-40"
          >
            Send sign-in link
          </button>
        </>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
