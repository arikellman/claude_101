"use client";

import { useEffect, useState } from "react";
import { browserClient } from "./supabase/client";

/**
 * The one auth-loading implementation in the app. Every page used to duplicate this
 * getSession()/onAuthStateChange pair inline, and every copy except page.tsx's original
 * forgot the "session came back null" case - so an expired token showed "Loading…"
 * forever instead of falling back to sign-in. Fixing it once here fixes it everywhere.
 */
export function useSession(): { userId: string | null; loading: boolean } {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = browserClient();
    db.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user.id ?? null);
      setLoading(false);
    });
    const { data: sub } = db.auth.onAuthStateChange((_e, session) => {
      setUserId(session?.user.id ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { userId, loading };
}
