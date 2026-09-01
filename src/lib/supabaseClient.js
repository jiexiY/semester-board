import { createClient } from "@supabase/supabase-js";

const AUTH_STORAGE_KEY = "fall2026Quest:supabaseAuth:v1";

function viteEnvironment() {
  return import.meta.env || {};
}

export function readSupabaseBrowserConfig(environment = viteEnvironment()) {
  const url = String(environment.VITE_SUPABASE_URL || "").trim();
  const publishableKey = String(environment.VITE_SUPABASE_PUBLISHABLE_KEY || "").trim();
  return {
    configured: /^https:\/\/[a-z0-9-]+\.supabase\.co$/u.test(url)
      && /^sb_publishable_[A-Za-z0-9._-]+$/u.test(publishableKey),
    publishableKey,
    url,
  };
}

let browserClient = null;
let browserClientSignature = null;

export function createSemesterBoardSupabaseClient(config, options = {}) {
  if (!config?.configured) {
    throw new Error("Cloud accounts are not configured for this Semester Board build.");
  }
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
      storageKey: AUTH_STORAGE_KEY,
    },
    ...options,
  });
}

export function getSupabaseBrowserClient(environment = viteEnvironment()) {
  const config = readSupabaseBrowserConfig(environment);
  if (!config.configured) return null;
  const signature = `${config.url}|${config.publishableKey}`;
  if (!browserClient || browserClientSignature !== signature) {
    browserClient = createSemesterBoardSupabaseClient(config);
    browserClientSignature = signature;
  }
  return browserClient;
}

export function resetSupabaseBrowserClientForTests() {
  browserClient = null;
  browserClientSignature = null;
}
