const returnKey = "java-blueprints:auth-return";

// Authentication may only return to a route owned by this application.
export function safeAuthReturn(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return "/projects";
  try {
    const url = new URL(value, location.origin);
    if (
      url.origin !== location.origin ||
      !/^\/(?:projects(?:\/[^/]+(?:\/runs\/[^/]+)?)?|settings(?:\/(?:profile|security|appearance|friends|integrations))?|account|friends|(?:u|profile)\/[^/]+(?:\/friends)?)?\/?$/.test(
        url.pathname,
      )
    )
      return "/projects";
    return url.pathname + url.search;
  } catch {
    return "/projects";
  }
}

export function authReturn(): string {
  return safeAuthReturn(new URLSearchParams(location.search).get("next"));
}

export function rememberAuthReturn(): void {
  try {
    sessionStorage.setItem(returnKey, authReturn());
  } catch {}
}

export function consumeAuthReturn(): string {
  try {
    const path = sessionStorage.getItem(returnKey);
    sessionStorage.removeItem(returnKey);
    return safeAuthReturn(path);
  } catch {
    return "/projects";
  }
}

export function authLink(route: string): string {
  const next = authReturn();
  return (
    route + (next === "/projects" ? "" : "?next=" + encodeURIComponent(next))
  );
}
