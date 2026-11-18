async function request(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api/admin/borrow-requests${path}`, {
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

export const listAdminBorrowRequests = (status) =>
  request(`/?status=${encodeURIComponent(status)}`).then((data) => data);
export const approveBorrowRequest = (id) =>
  request(`/${encodeURIComponent(id)}/approve`, { method: "POST", body: {} }).then((data) => data.request);
export const rejectBorrowRequest = (id, reason) =>
  request(`/${encodeURIComponent(id)}/reject`, { method: "POST", body: { reason } }).then((data) => data.request);
export const returnBorrowRequest = (id) =>
  request(`/${encodeURIComponent(id)}/return`, { method: "POST", body: {} }).then((data) => data.request);
