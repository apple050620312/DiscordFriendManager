import assert from "node:assert/strict";
import test from "node:test";

import { DiscordApi, DiscordApiError } from "../static/discord-api.js";

test("adds the in-memory token only to Discord requests", async () => {
  const calls = [];
  const api = new DiscordApi("secret-token", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: "1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await api.currentUser();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.com/api/v9/users/@me");
  assert.equal(calls[0].options.headers.Authorization, "secret-token");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
});

test("retries a 429 using retry_after", async () => {
  let calls = 0;
  const api = new DiscordApi("token", async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ retry_after: 0.001 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(await api.relationships(), []);
  assert.equal(calls, 2);
});

test("surfaces Discord errors without retrying non-429 responses", async () => {
  let calls = 0;
  const api = new DiscordApi("invalid", async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "401: Unauthorized", code: 0 }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  });

  await assert.rejects(api.currentUser(), (error) => {
    assert.ok(error instanceof DiscordApiError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(calls, 1);
});
