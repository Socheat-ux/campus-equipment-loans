// Calls /api/notifications. POST bodies are JSON, because the server refuses anything else.
async function request(path, body) {
  let res;
  try {
    res = await fetch(
      `/api/notifications${path}`,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    throw Object.assign(new Error("Cannot reach the server."), { status: 0 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // The bell only runs for a signed-in user, so a 401 here means the session really ended.
    if (res.status === 401) window.dispatchEvent(new Event("auth-expired"));
    throw Object.assign(new Error(data?.error ?? "Could not load notifications."), { status: res.status });
  }
  return data;
}

export const listNotifications = () => request("/");
// Pass a list of ids, or "all" with the newest id the user has seen, so later arrivals stay unread.
export const markNotificationsRead = (ids, upTo) => request("/read", ids === "all" ? { all: true, upTo } : { ids });
