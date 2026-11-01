import { createHash, randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import type { E2EUser } from "./global-setup";
import { signIn, state } from "./helpers";

/**
 * Connecting apps to OpenCMO (security fixes plan, fixes 5 and 6): only paid accounts may
 * connect. A real authorization comes from local Supabase's OAuth server, registered the way
 * claude.ai registers itself (dynamic client registration).
 */

// PKCE: the challenge goes to authorize, the verifier to the token exchange.
const VERIFIER = randomBytes(48).toString("base64url");
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const admin = () => createClient(state().url, state().service, { auth: { persistSession: false } });

/** Registers a client for `redirect` and starts an authorization. */
async function authorize(page: Page, redirect: string): Promise<{ id: string; clientId: string }> {
  const { url, anon } = state();
  const registered = await page.request.post(`${url}/auth/v1/oauth/clients/register`, {
    headers: { apikey: anon, "content-type": "application/json" },
    data: { client_name: "E2E client", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] },
  });
  expect(registered.ok()).toBeTruthy();
  const { client_id } = (await registered.json()) as { client_id: string };
  const query = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirect,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "e2e",
  });
  const started = await page.request.get(`${url}/auth/v1/oauth/authorize?${query}`, { maxRedirects: 0 });
  const id = new URL(started.headers().location ?? "", "http://x").searchParams.get("authorization_id");
  expect(id).toBeTruthy();
  return { id: id!, clientId: client_id };
}

const authorizationFor = async (page: Page, redirect: string) => (await authorize(page, redirect)).id;

const decide = (page: Page, id: string, decision: "approve" | "deny") =>
  page.request.post("/api/v1/oauth/consent", { data: { authorization_id: id, decision } });

test("free account: Settings shows the paid-plan path instead of API keys", async ({ page }) => {
  await signIn(page, state().users.b);
  await page.goto("/app/settings");
  const keys = page.getByTestId("api-keys");
  await expect(keys.getByTestId("mcp-paid-plan")).toContainText("Connect Claude with a paid plan");
  await expect(keys.getByRole("link", { name: "See plans" })).toHaveAttribute("href", "/app/billing");
  await expect(page.getByTestId("api-key-create")).toHaveCount(0);
  await expect(page.getByTestId("connected-apps").getByTestId("mcp-paid-plan")).toBeVisible();
});

test("free account: the consent screen offers Deny only, and approve is refused", async ({ page }) => {
  await signIn(page, state().users.b);
  const id = await authorizationFor(page, "http://localhost:9/callback");
  await page.goto(`/oauth/consent?authorization_id=${id}`);
  await expect(page.getByTestId("oauth-consent")).toContainText("part of the paid plans");
  await expect(page.getByTestId("oauth-approve")).toHaveCount(0);
  await expect(page.getByTestId("oauth-deny")).toBeVisible();

  const refused = await decide(page, id, "approve");
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain("part of the paid plans");
});

test.describe("paid account", () => {
  // Its own user, so the plan change never leaks into the specs that use the shared free users.
  let paid: E2EUser;
  test.beforeAll(async () => {
    const email = "e2e-oauth-paid@test.local";
    const password = "e2e-oauth-paid-password";
    const { data: list } = await admin().auth.admin.listUsers({ perPage: 200 });
    for (const old of list?.users ?? []) if (old.email === email) await admin().auth.admin.deleteUser(old.id);
    const { data, error } = await admin().auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`Could not create the paid user: ${error?.message}`);
    await admin().from("profiles").update({ plan: "starter" }).eq("id", data.user.id);
    paid = { email, password, id: data.user.id };
  });
  test.afterAll(async () => {
    if (paid) await admin().auth.admin.deleteUser(paid.id);
  });

  test("an app whose redirect host is not allowlisted cannot be approved", async ({ page }) => {
    await signIn(page, paid);
    const { id, clientId } = await authorize(page, "https://evil.example/callback");
    await page.goto(`/oauth/consent?authorization_id=${id}`);
    await expect(page.getByTestId("oauth-consent").locator("h1")).toHaveText("This app can't connect to OpenCMO.");
    await expect(page.getByTestId("oauth-consent")).toContainText("evil.example");
    await expect(page.getByTestId("oauth-approve")).toHaveCount(0);

    const refused = await decide(page, id, "approve");
    expect(refused.status()).toBe(403);
    expect(await refused.text()).toContain("This app can't connect to OpenCMO.");
    const { data } = await admin().from("mcp_grants").select("client_id").eq("client_id", clientId);
    expect(data).toEqual([]);
    // Review R3: Deny does not send the founder on to the unsupported app's own URL (no open redirect).
    const denied = await decide(page, id, "deny");
    expect(denied.status()).toBe(200);
    expect(await denied.json()).toMatchObject({ redirect_url: null, denied: true });
  });

  test("approving an allowlisted app records the grant, and Disconnect revokes it", async ({ page }) => {
    await signIn(page, paid);
    const redirect = "http://localhost:9/callback";
    const { id, clientId } = await authorize(page, redirect);
    await page.goto(`/oauth/consent?authorization_id=${id}`);
    await expect(page.getByTestId("oauth-consent").locator("h1")).toHaveText("Connect E2E client (localhost)");

    const approved = await decide(page, id, "approve");
    expect(approved.ok()).toBeTruthy();
    const back = new URL(((await approved.json()) as { redirect_url: string }).redirect_url);
    expect(`${back.origin}${back.pathname}`).toBe(redirect);

    // The token the app gets names the same client our grant does: that is what the MCP server matches.
    const exchanged = await page.request.post(`${state().url}/auth/v1/oauth/token`, {
      headers: { apikey: state().anon },
      form: { grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: redirect, client_id: clientId, code_verifier: VERIFIER },
    });
    expect(exchanged.ok()).toBeTruthy();
    const { access_token } = (await exchanged.json()) as { access_token: string };
    const claims = JSON.parse(Buffer.from(access_token.split(".")[1]!, "base64url").toString("utf8")) as { client_id?: string };
    expect(claims.client_id).toBe(clientId);
    const grant = async () => (await admin().from("mcp_grants").select("revoked_at").eq("user_id", paid.id).eq("client_id", clientId).single()).data;
    expect(await grant()).toEqual({ revoked_at: null });

    await page.goto("/app/settings");
    const row = page.getByTestId("connected-app-list").locator("li", { hasText: "E2E client" });
    await expect(row).toContainText("connected");
    await page.getByTestId(`connected-app-disconnect-${clientId}`).click();
    await expect(row).toHaveCount(0);
    expect((await grant())?.revoked_at).toBeTruthy();
  });
});
