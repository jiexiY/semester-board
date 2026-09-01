import test from "node:test";
import assert from "node:assert/strict";
import { accountErrorMessage } from "../src/hooks/useCloudAccount.js";
import { readSupabaseBrowserConfig } from "../src/lib/supabaseClient.js";

test("Supabase browser config requires a project URL and browser-safe publishable key", () => {
  assert.equal(readSupabaseBrowserConfig({}).configured, false);
  assert.equal(readSupabaseBrowserConfig({
    VITE_SUPABASE_PUBLISHABLE_KEY: "service_role_secret",
    VITE_SUPABASE_URL: "https://semester-board.supabase.co",
  }).configured, false);
  assert.equal(readSupabaseBrowserConfig({
    VITE_SUPABASE_PUBLISHABLE_KEY: "eyJhbGciOiJIUzI1NiJ9.legacy-jwt-shaped-key",
    VITE_SUPABASE_URL: "https://semester-board.supabase.co",
  }).configured, false);
  assert.equal(readSupabaseBrowserConfig({
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example123",
    VITE_SUPABASE_URL: "https://semester-board.supabase.co",
  }).configured, true);
});

test("cloud account errors do not reveal whether an email exists or expose backend details", () => {
  assert.equal(accountErrorMessage({ message: "Invalid login credentials" }, "signin"), "Email or password is incorrect.");
  assert.equal(
    accountErrorMessage({ message: "Email not confirmed" }, "signin"),
    "Confirm your email before signing in. Check your inbox or resend the confirmation.",
  );
  assert.equal(
    accountErrorMessage({ message: "duplicate key violates account_profiles_pkey" }, "signup"),
    "The account could not be created. Check the details and try again.",
  );
});
