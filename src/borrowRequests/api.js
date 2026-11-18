// Calls /api/borrow-requests. Creating a request always sends JSON, because the server refuses anything else.
async function request(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api/borrow-requests${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("Cannot reach the server. Check your connection and try again."), { status: 0 });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("auth-expired"));
    if (res.status === 403) window.dispatchEvent(new Event("auth-changed"));
    throw Object.assign(new Error(data?.error ?? "Something went wrong. Try again."), {
      status: res.status,
      fields: data?.fields,
    });
  }
  return data;
}

export const listBorrowRequests = () => request("/").then((data) => data.requests);
export const getBorrowRequest = (id) =>
  request(`/${encodeURIComponent(id)}`).then((data) => data.request);
export const createBorrowRequest = (input) =>
  request("/", { method: "POST", body: input }).then((data) => data.request);
export const cancelBorrowRequest = (id, reason) =>
  request(`/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason } }).then((data) => data.request);
