async function request() {
  let response;
  try {
    response = await fetch("/api/admin/overdue");
  } catch {
    throw Object.assign(new Error("Cannot reach the server. Check your connection and try again."), { status: 0 });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("auth-expired"));
    if (response.status === 403) window.dispatchEvent(new Event("auth-changed"));
    throw Object.assign(new Error(data?.error ?? "Could not load overdue loans."), { status: response.status });
  }
  return data;
}

export const listOverdueLoans = request;
