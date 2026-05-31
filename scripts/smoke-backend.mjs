#!/usr/bin/env node

const httpBaseUrl = process.env.PI_WEB_BASE_URL || "http://127.0.0.1:3000";
const timeoutMs = Number(process.env.PI_WEB_SMOKE_TIMEOUT_MS || 30_000);
const smokePassword = process.env.PI_WEB_SMOKE_ADMIN_PASSWORD;

const sseUrl = `${httpBaseUrl}/api/agent/events`;

let authCookie = "";

function logStep(message) {
  console.log(`[smoke] ${message}`);
}

function fail(message, details) {
  console.error(`[smoke] FAIL: ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function assert(condition, message, details) {
  if (!condition) fail(message, details);
}

function requireSmokePassword() {
  if (!smokePassword) {
    fail(
      "PI_WEB_SMOKE_ADMIN_PASSWORD must be set so the smoke test can log in.",
    );
  }
}

function responseCookie(response) {
  const header = response.headers.get("set-cookie");
  return header?.split(";")[0] ?? "";
}

async function requestJson(method, path, body, options = {}) {
  const url = `${httpBaseUrl}${path}`;
  const headers = new Headers(options.headers);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (options.authenticated && authCookie) headers.set("cookie", authCookie);

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    fail(`${method} ${path} is not reachable. Is \`pnpm dev\` running?`, error);
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    fail(`${method} ${path} returned non-JSON`, text);
  }

  if (!response.ok && !options.allowError) {
    fail(
      `${method} ${path} returned HTTP ${response.status}`,
      JSON.stringify(payload, null, 2),
    );
  }

  return { response, payload };
}

function assertAgentState(state, context) {
  assert(
    state?.protocolVersion === 6,
    `${context} protocolVersion should be 6`,
    JSON.stringify(state, null, 2),
  );
  assert(
    typeof state.cwd === "string" && state.cwd.length > 0,
    `${context} should include cwd`,
    JSON.stringify(state, null, 2),
  );
  assert(
    Array.isArray(state.loadedSessions),
    `${context} should include loadedSessions[]`,
    JSON.stringify(state, null, 2),
  );
  assert(
    Array.isArray(state.persistedSessions),
    `${context} should include persistedSessions[]`,
    JSON.stringify(state, null, 2),
  );
  assert(
    state.capabilities?.permissions === true,
    `${context} should include capabilities`,
    JSON.stringify(state, null, 2),
  );
}

async function testUnauthenticatedHttp() {
  logStep("checking unauthenticated HTTP rejection");
  for (const path of ["/api/health", "/api/agent/state"]) {
    const { response, payload } = await requestJson("GET", path, undefined, {
      allowError: true,
    });
    assert(
      response.status === 401,
      `${path} should require authentication`,
      JSON.stringify(payload, null, 2),
    );
  }
}

async function testUnauthenticatedSse() {
  logStep("checking unauthenticated SSE rejection");
  const response = await fetch(sseUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    fail("unauthenticated SSE endpoint is not reachable. Is `pnpm dev` running?", error);
  });
  assert(
    response.status === 401,
    "GET /api/agent/events should require authentication",
    `got HTTP ${response.status}`,
  );
}

async function login() {
  requireSmokePassword();
  logStep("logging in");
  const { response, payload } = await requestJson("POST", "/api/auth/login", {
    password: smokePassword,
  });
  assert(
    payload?.ok === true && payload?.user?.id === "admin",
    "login returned an unexpected payload",
    JSON.stringify(payload, null, 2),
  );
  authCookie = responseCookie(response);
  assert(authCookie, "login did not set a session cookie");
}

async function testAuthenticatedRestApi() {
  logStep("checking authenticated health");
  const { payload: health } = await requestJson(
    "GET",
    "/api/health",
    undefined,
    { authenticated: true },
  );
  assert(
    health?.ok === true && health?.service === "pi-web-agent",
    "health endpoint returned an unexpected payload",
    JSON.stringify(health, null, 2),
  );

  logStep("checking authenticated REST state");
  const { payload: initialState } = await requestJson(
    "GET",
    "/api/agent/state",
    undefined,
    { authenticated: true },
  );
  assertAgentState(initialState, "initial state");

  logStep("checking session create/history/model state");
  const { payload: created } = await requestJson(
    "POST",
    "/api/agent/sessions",
    {},
    { authenticated: true },
  );
  assertAgentState(created, "created session response");
  assert(
    typeof created.sessionId === "string" && created.sessionId.length > 0,
    "session create should return sessionId",
    JSON.stringify(created, null, 2),
  );

  const sessionPath = `/api/agent/sessions/${encodeURIComponent(created.sessionId)}`;
  const { payload: history } = await requestJson(
    "GET",
    `${sessionPath}/history`,
    undefined,
    { authenticated: true },
  );
  assert(
    history?.sessionId === created.sessionId && Array.isArray(history.messages),
    "history response should include sessionId and messages[]",
    JSON.stringify(history, null, 2),
  );

  const { payload: models } = await requestJson(
    "GET",
    `${sessionPath}/models`,
    undefined,
    { authenticated: true },
  );
  assert(
    models?.sessionId === created.sessionId && Array.isArray(models.models),
    "models response should include sessionId and models[]",
    JSON.stringify(models, null, 2),
  );

  const thinkingLevel =
    models.thinkingLevel ?? models.availableThinkingLevels?.[0];
  if (thinkingLevel) {
    const { payload: updatedThinking } = await requestJson(
      "PUT",
      `${sessionPath}/thinking`,
      { level: thinkingLevel },
      { authenticated: true },
    );
    assert(
      updatedThinking?.sessionId === created.sessionId,
      "thinking update should return model state",
      JSON.stringify(updatedThinking, null, 2),
    );
  }
}

async function logout() {
  logStep("logging out");
  const { payload } = await requestJson("POST", "/api/auth/logout", undefined, {
    authenticated: true,
  });
  assert(payload?.ok === true, "logout returned an unexpected payload");
}

await testUnauthenticatedHttp();
await testUnauthenticatedSse();
await login();
await testAuthenticatedRestApi();
await logout();
await testUnauthenticatedHttp();

console.log("[smoke] PASS");
