import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient, readSupabaseBrowserConfig } from "../lib/supabaseClient.js";

const DISPLAY_NAME_LIMIT = 40;

function cleanDisplayName(value) {
  return String(value || "").trim().replace(/\s+/gu, " ").slice(0, DISPLAY_NAME_LIMIT);
}

function cleanEmail(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

export function accountErrorMessage(error, action = "account") {
  const message = String(error?.message || "").toLocaleLowerCase("en-US");
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 429 || message.includes("rate limit") || message.includes("too many")) {
    return "Too many attempts. Wait a few minutes and try again.";
  }
  if (message.includes("email not confirmed") || message.includes("email_not_confirmed")) {
    return "Confirm your email before signing in. Check your inbox or resend the confirmation.";
  }
  if (message.includes("invalid login") || message.includes("invalid credentials")) {
    return "Email or password is incorrect.";
  }
  if (message.includes("network") || message.includes("fetch") || status >= 500) {
    return "We could not reach the account service. Your data on this device was not changed.";
  }
  if (action === "signup") {
    return "The account could not be created. Check the details and try again.";
  }
  if (action === "signin") return "Email or password is incorrect.";
  return "The account service could not complete that request.";
}

function profileFromRow(user, row) {
  const metadataName = cleanDisplayName(user?.user_metadata?.display_name);
  const emailName = cleanEmail(user?.email).split("@", 1)[0];
  return {
    email: cleanEmail(user?.email),
    id: user.id,
    migrationStatus: row?.migration_status || "pending",
    name: cleanDisplayName(row?.display_name) || metadataName || emailName || "Student",
    syncMode: "cloud",
  };
}

async function readOrCreateProfile(client, user) {
  const response = await client
    .from("account_profiles")
    .select("user_id, display_name, migration_status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (response.error) throw response.error;
  if (response.data) return profileFromRow(user, response.data);

  const fallback = profileFromRow(user, null);
  const created = await client
    .from("account_profiles")
    .insert({ display_name: fallback.name, user_id: user.id })
    .select("user_id, display_name, migration_status")
    .single();
  if (created.error) throw created.error;
  return profileFromRow(user, created.data);
}

export function useCloudAccount({ client: injectedClient, environment } = {}) {
  const config = useMemo(() => readSupabaseBrowserConfig(environment), [environment]);
  const client = useMemo(
    () => injectedClient || (config.configured ? getSupabaseBrowserClient(environment) : null),
    [config.configured, environment, injectedClient],
  );
  const [profile, setProfile] = useState(null);
  const [status, setStatus] = useState(() => (client ? "restoring" : "unconfigured"));
  const [notice, setNotice] = useState(null);
  const generationRef = useRef(0);

  const acceptSession = useCallback(async (session) => {
    const generation = ++generationRef.current;
    if (!session?.user) {
      setProfile(null);
      setStatus("signed_out");
      return;
    }
    setProfile(null);
    setStatus("restoring");
    try {
      const nextProfile = await readOrCreateProfile(client, session.user);
      if (generation !== generationRef.current) return;
      setProfile(nextProfile);
      setStatus("signed_in");
      setNotice(null);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setProfile(null);
      setStatus("error");
      setNotice(accountErrorMessage(error));
    }
  }, [client]);

  useEffect(() => {
    if (!client) {
      setProfile(null);
      setStatus("unconfigured");
      return undefined;
    }
    let active = true;
    const generation = ++generationRef.current;
    setStatus("restoring");
    client.auth.getSession().then(({ data, error }) => {
      if (!active || generation !== generationRef.current) return;
      if (error) {
        setProfile(null);
        setStatus("error");
        setNotice(accountErrorMessage(error));
        return;
      }
      void acceptSession(data?.session || null);
    });
    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setTimeout(() => {
        if (active) void acceptSession(session);
      }, 0);
    });
    return () => {
      active = false;
      generationRef.current += 1;
      listener?.subscription?.unsubscribe?.();
    };
  }, [acceptSession, client]);

  const signIn = useCallback(async ({ email, password }) => {
    if (!client) throw new Error("Cloud accounts are not configured.");
    setNotice(null);
    const result = await client.auth.signInWithPassword({
      email: cleanEmail(email),
      password: typeof password === "string" ? password : "",
    });
    if (result.error) throw new Error(accountErrorMessage(result.error, "signin"));
    await acceptSession(result.data?.session || null);
    return result.data;
  }, [acceptSession, client]);

  const signUp = useCallback(async ({ displayName, email, password }) => {
    if (!client) throw new Error("Cloud accounts are not configured.");
    const normalizedName = cleanDisplayName(displayName);
    if (!normalizedName) throw new Error("Enter a display name.");
    setNotice(null);
    const result = await client.auth.signUp({
      email: cleanEmail(email),
      password: typeof password === "string" ? password : "",
      options: {
        data: { display_name: normalizedName },
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
      },
    });
    if (result.error) throw new Error(accountErrorMessage(result.error, "signup"));
    if (result.data?.session) await acceptSession(result.data.session);
    return {
      confirmationRequired: !result.data?.session,
      email: cleanEmail(email),
    };
  }, [acceptSession, client]);

  const resendConfirmation = useCallback(async (email) => {
    if (!client) throw new Error("Cloud accounts are not configured.");
    const result = await client.auth.resend({
      email: cleanEmail(email),
      options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` },
      type: "signup",
    });
    if (result.error) throw new Error(accountErrorMessage(result.error, "signup"));
    return true;
  }, [client]);

  const signOut = useCallback(async ({ everywhere = false } = {}) => {
    if (!client) {
      generationRef.current += 1;
      setProfile(null);
      setStatus("signed_out");
      setNotice(null);
      return;
    }
    const result = await client.auth.signOut({ scope: everywhere ? "global" : "local" });
    if (result.error) throw new Error(accountErrorMessage(result.error));
    generationRef.current += 1;
    setProfile(null);
    setStatus("signed_out");
    setNotice(null);
  }, [client]);

  const setMigrationStatus = useCallback(async (migrationStatus) => {
    if (!client || !profile?.id || !["imported", "skipped"].includes(migrationStatus)) {
      throw new Error("The migration decision could not be saved.");
    }
    const result = await client
      .from("account_profiles")
      .update({ migration_status: migrationStatus })
      .eq("user_id", profile.id)
      .select("user_id, display_name, migration_status")
      .single();
    if (result.error) throw new Error(accountErrorMessage(result.error));
    setProfile((current) => current ? { ...current, migrationStatus } : current);
  }, [client, profile?.id]);

  return {
    client,
    configured: Boolean(client),
    notice,
    profile,
    resendConfirmation,
    setMigrationStatus,
    signIn,
    signOut,
    signUp,
    status,
  };
}
