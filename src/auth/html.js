// Sends an auth page with headers that stop caching, framing and script execution.
// form-action allows the post-login redirect back to ChatGPT.

export function sendHtml(res, status, html) {
  res
    .status(status)
    .set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    })
    .type("html")
    .send(html);
}
