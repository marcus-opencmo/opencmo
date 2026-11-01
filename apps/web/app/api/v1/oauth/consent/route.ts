import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { allowedRedirectHost, PAID_PLAN_CONSENT, paidUser, recordGrant, UNKNOWN_APP_CONSENT } from "@/lib/auth/consent";

export const dynamic = "force-dynamic";

const body = z.object({
  authorization_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  decision: z.enum(["approve", "deny"]),
});

/**
 * Allow or Deny on the consent screen (`/oauth/consent`) of OpenCMO's OAuth server. Returns the
 * URL back to the app that asked (its registered redirect URI, with the code or `access_denied`);
 * the page navigates there itself, because the site's CSP (`form-action 'self'`) blocks a form
 * that redirects to another site. Signed in, same site only (`withApi`).
 *
 * Approve is a plain POST anyone signed in can send, so the page's rules hold here too: an
 * allowlisted redirect host, a paid plan, and a grant in `mcp_grants` recorded before Supabase
 * approves (a grant without a token is harmless; a token without a grant would be useless).
 */
export const POST = withApi({ body, rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } }, async ({ supabase, user, body }) => {
  // Supabase ties the request to the user when its details are read: read them in this request
  // too before answering. Already approved: the details are the way back.
  const details = await supabase.auth.oauth.getAuthorizationDetails(body.authorization_id);
  if (details.error || !details.data) throw new ApiError(404, "This request has expired. Start connecting again from the app.");
  if (!("authorization_id" in details.data)) return { redirect_url: details.data.redirect_url };

  if (body.decision === "approve") {
    if (!allowedRedirectHost(details.data.redirect_uri)) throw new ApiError(403, UNKNOWN_APP_CONSENT);
    if (!(await paidUser(supabase, user.id))) throw new ApiError(403, PAID_PLAN_CONSENT);
    if (!(await recordGrant(supabase, details.data.client.id))) throw new ApiError(502, "That did not go through. Please try again.");
  }

  const options = { skipBrowserRedirect: true };
  const { data, error } =
    body.decision === "approve"
      ? await supabase.auth.oauth.approveAuthorization(body.authorization_id, options)
      : await supabase.auth.oauth.denyAuthorization(body.authorization_id, options);
  if (error || !data?.redirect_url) {
    console.error("[oauth] consent failed", error);
    throw new ApiError(502, "That did not go through. Please try again.");
  }
  return { redirect_url: data.redirect_url };
});
