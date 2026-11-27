// Minimal, unstyled HTML for Better Auth's OAuth provider to redirect a
// browser to mid-flow. Functional teaching code, not a designed UI - see
// NOTES.md for what a real client-facing version would need.

function html(body: string): Response {
  return new Response(`<!doctype html><html><body>${body}</body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// Better Auth redirects here (preserving the original /oauth2/authorize
// query string) when the caller has no session yet. After sign-in (or
// sign-up) succeeds, we re-navigate to /oauth2/authorize with that same
// query string to resume the flow - it now finds a session cookie and
// either completes or moves on to consent.
export function loginPage(originalQuery: string): Response {
  const resumeUrl = `/api/auth/oauth2/authorize?${originalQuery}`;
  return html(`
    <h1>Sign in</h1>
    <form id="f">
      <input name="name" placeholder="Name (sign up only)" autocomplete="name">
      <input name="email" type="email" placeholder="Email" required autocomplete="email">
      <input name="password" type="password" placeholder="Password" required autocomplete="current-password">
      <button type="submit" data-mode="sign-in">Sign in</button>
      <button type="submit" data-mode="sign-up">Sign up</button>
    </form>
    <p id="err" style="color:red"></p>
    <script>
      const form = document.getElementById("f");
      const err = document.getElementById("err");
      for (const button of form.querySelectorAll("button")) {
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          err.textContent = "";
          const mode = button.dataset.mode;
          const body = Object.fromEntries(new FormData(form));
          const response = await fetch(\`/api/auth/\${mode}/email\`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            err.textContent = (await response.json().catch(() => null))?.message ?? "Sign-in failed.";
            return;
          }
          window.location.href = ${JSON.stringify(resumeUrl)};
        });
      }
    </script>
  `);
}

// Better Auth redirects here with client_id, scope, claims and code as
// query params once the user is signed in but hasn't approved this client
// yet. Approving calls /api/auth/oauth2/consent, which answers with
// { redirect: true, url } - the URL to send the browser to to finish the
// flow back at the client (Claude, ChatGPT, ...).
export function consentPage(params: URLSearchParams): Response {
  const clientId = params.get("client_id") ?? "";
  const scope = params.get("scope") ?? "";
  const code = params.get("code") ?? "";
  return html(`
    <h1>Allow access?</h1>
    <p><strong>${escapeHtml(clientId)}</strong> wants: ${escapeHtml(scope)}</p>
    <button id="allow">Allow</button>
    <button id="deny">Deny</button>
    <p id="err" style="color:red"></p>
    <script>
      async function respond(accept) {
        const response = await fetch("/api/auth/oauth2/consent?code=${encodeURIComponent(code)}", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accept, oauth_query: ${JSON.stringify(params.toString())} }),
        });
        const result = await response.json().catch(() => null);
        if (response.ok && result?.url) {
          window.location.href = result.url;
        } else {
          document.getElementById("err").textContent = result?.message ?? "Could not complete authorization.";
        }
      }
      document.getElementById("allow").addEventListener("click", () => respond(true));
      document.getElementById("deny").addEventListener("click", () => respond(false));
    </script>
  `);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
