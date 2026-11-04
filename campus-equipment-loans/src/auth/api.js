// Calls /api/auth/*. Always sends JSON, because the server rejects every other content type.
export async function api(path, body) {
  let res;
  try {
    res = await fetch(`/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("Cannot reach the server. Check your connection and try again."), { status: 0 });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    // A 401 from these three just means "not logged in / wrong password"; anywhere else it means the session ended.
    if (res.status === 401 && !["/login", "/signup", "/me"].includes(path)) window.dispatchEvent(new Event("auth-expired"));
    throw Object.assign(new Error(data?.error ?? "Something went wrong. Try again."), { status: res.status });
  }
  return data;
}
