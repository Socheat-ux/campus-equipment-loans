// Calls /api/equipment. The server only accepts JSON bodies and requires an administrator session.
async function request(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api/equipment${path}`, {
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
    // The role may have changed since sign-in, so refresh who the user is and let the page guards react.
    if (res.status === 403) window.dispatchEvent(new Event("auth-changed"));
    throw Object.assign(new Error(data?.error ?? "Something went wrong. Try again."), {
      status: res.status,
      fields: data?.fields,
    });
  }
  return data;
}

export const listEquipment = () => request("/").then((data) => data.equipment);
export const getEquipment = (id) => request(`/${encodeURIComponent(id)}`).then((data) => data.equipment);
export const createEquipment = (input) => request("/", { method: "POST", body: input }).then((data) => data.equipment);
export const updateEquipment = (id, input) =>
  request(`/${encodeURIComponent(id)}`, { method: "PUT", body: input }).then((data) => data.equipment);
