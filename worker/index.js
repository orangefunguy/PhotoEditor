/**
 * Cloudflare Worker — reverse proxy for editor.herooflegend.com
 * Forwards all traffic to the Render-hosted PhotoEditor service.
 */
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const originBase = (env.API_ORIGIN || "https://photoeditor-oiom.onrender.com").replace(
      /\/$/,
      ""
    );
    const targetUrl = originBase + incoming.pathname + incoming.search;

    const headers = new Headers(request.headers);
    // Drop hop-by-hop headers that can break upstream
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.delete("cf-ipcountry");
    headers.delete("content-length");

    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) {
      headers.set("X-Forwarded-For", clientIp);
      headers.set("X-Real-IP", clientIp);
    }
    headers.set("X-Forwarded-Proto", "https");
    headers.set("X-Forwarded-Host", incoming.host);

    /** @type {RequestInit} */
    const init = {
      method: request.method,
      headers,
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }

    let response;
    try {
      response = await fetch(targetUrl, init);
    } catch (err) {
      return new Response(
        JSON.stringify({
          detail: "PhotoEditor origin unreachable",
          origin: originBase,
          error: String(err && err.message ? err.message : err),
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const outHeaders = new Headers(response.headers);
    const location = outHeaders.get("Location");
    if (location) {
      try {
        const originHost = new URL(originBase).host;
        const locUrl = new URL(location, originBase);
        if (locUrl.host === originHost) {
          locUrl.protocol = "https:";
          locUrl.host = incoming.host;
          outHeaders.set("Location", locUrl.toString());
        }
      } catch {
        /* leave Location as-is */
      }
    }

    // Avoid CF compressing twice issues
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  },
};
