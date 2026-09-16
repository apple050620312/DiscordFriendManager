const API_BASE = "https://discord.com/api/v10";

export class DiscordApiError extends Error {
  constructor(message, status = 0, code = null) {
    super(message);
    this.name = "DiscordApiError";
    this.status = status;
    this.code = code;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class DiscordApi {
  #token;
  #fetch;
  #logger;
  #queue = Promise.resolve();
  #readyAt = 0;

  constructor(token, fetchImplementation = fetch, logger = () => {}) {
    this.#token = token;
    this.#fetch = fetchImplementation;
    this.#logger = logger;
  }

  clearToken() {
    this.#token = "";
  }

  request(path, options = {}) {
    const run = () => this.#request(path, options);
    const pending = this.#queue.then(run, run);
    this.#queue = pending.catch(() => {});
    return pending;
  }

  #log(event, path, details = {}) {
    try {
      this.#logger({
        time: new Date().toISOString(),
        event,
        path: path.replace(/\d{10,}/g, ":id"),
        ...details,
      });
    } catch {
      // Diagnostics must never interrupt an API request.
    }
  }

  async #request(path, { method = "GET", body } = {}) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const wait = this.#readyAt - Date.now();
      if (wait > 0) await sleep(wait);

      let response;
      this.#log("request", path, { method, attempt: attempt + 1 });
      try {
        response = await this.#fetch(`${API_BASE}${path}`, {
          method,
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          headers: {
            Authorization: this.#token,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        this.#log("network_error", path, {
          method,
          attempt: attempt + 1,
          error_name: error?.name || "Error",
          error_message: error?.message || String(error),
          online: typeof navigator === "undefined" ? null : navigator.onLine,
        });
        if (attempt === 0) {
          this.#log("retry_wait", path, { milliseconds: 500 });
          await sleep(500);
          continue;
        }
        throw new DiscordApiError(
          "瀏覽器無法連線 Discord API。若正在使用 Codex 內建瀏覽器，請改用一般 Chrome 或 Edge；內建瀏覽器可能封鎖跨站授權請求。",
        );
      }

      const payload = await responseBody(response);
      this.#log("response", path, {
        method,
        attempt: attempt + 1,
        status: response.status,
        response_type: response.type,
        redirected: response.redirected,
      });
      if (response.status === 429) {
        const retryHeader = Number(response.headers.get("Retry-After"));
        const retryBody = Number(payload?.retry_after);
        const retrySeconds = Number.isFinite(retryHeader) && retryHeader > 0
          ? retryHeader
          : (Number.isFinite(retryBody) && retryBody > 0 ? retryBody : 1);
        this.#readyAt = Date.now() + Math.ceil(retrySeconds * 1000) + 100;
        this.#log("rate_limit_wait", path, { retry_seconds: retrySeconds });
        continue;
      }

      const remaining = Number(response.headers.get("X-RateLimit-Remaining"));
      const resetAfter = Number(response.headers.get("X-RateLimit-Reset-After"));
      if (remaining === 0 && Number.isFinite(resetAfter) && resetAfter > 0) {
        this.#readyAt = Math.max(this.#readyAt, Date.now() + Math.ceil(resetAfter * 1000) + 100);
      }

      if (!response.ok) {
        const detail = typeof payload?.message === "string" ? `：${payload.message}` : "";
        throw new DiscordApiError(
          `Discord API 回傳 HTTP ${response.status}${detail}`,
          response.status,
          payload?.code ?? null,
        );
      }
      return payload;
    }
    throw new DiscordApiError("Discord 持續回傳 429，已暫停請求；請稍後再試。", 429);
  }

  currentUser() {
    return this.request("/users/@me");
  }

  relationships() {
    return this.request("/users/@me/relationships");
  }

  privateChannels() {
    return this.request("/users/@me/channels");
  }

  startPrivateMessage(userId) {
    return this.request("/users/@me/channels", { method: "POST", body: { recipient_id: userId } });
  }

  removeFriend(userId) {
    return this.request(`/users/@me/relationships/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  sendFriendRequest(userId) {
    return this.request(`/users/@me/relationships/${encodeURIComponent(userId)}`, { method: "PUT", body: {} });
  }
}
