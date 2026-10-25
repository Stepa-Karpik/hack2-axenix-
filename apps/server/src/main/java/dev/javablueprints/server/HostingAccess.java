package dev.javablueprints.server;

import java.net.URI;
import java.util.Locale;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Explicit deployment boundary. Local compatibility remains the default. */
@Component
final class HostingAccess {
  private static final Set<String> LOCAL_HOSTS = Set.of("localhost", "127.0.0.1", "[::1]", "::1");
  private final boolean hosted;
  private final String host;
  private final String origin;

  HostingAccess(
      @Value("${jb.hosting.enabled:false}") boolean hosted,
      @Value("${jb.public-url:http://127.0.0.1:5174}") String publicUrl,
      @Value("${server.servlet.session.cookie.secure:false}") boolean secureCookie) {
    this.hosted = hosted;
    if (!hosted) {
      host = null;
      origin = null;
      return;
    }
    if (!secureCookie)
      throw new IllegalArgumentException("Hosted mode requires Secure session cookies");
    try {
      URI uri = URI.create(publicUrl);
      String candidate = uri.getHost();
      if (!"https".equalsIgnoreCase(uri.getScheme())
          || candidate == null
          || !candidate.matches("(?i)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?")
          || candidate.contains("..")
          || uri.getRawUserInfo() != null
          || uri.getRawQuery() != null
          || uri.getRawFragment() != null
          || (uri.getPort() != -1 && uri.getPort() != 443)
          || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/")))
        throw new IllegalArgumentException("Invalid canonical URL");
      host = candidate.toLowerCase(Locale.ROOT);
      origin = "https://" + host;
    } catch (IllegalArgumentException e) {
      throw new IllegalArgumentException("Hosted mode requires a canonical HTTPS root URL", e);
    }
  }

  boolean hosted() {
    return hosted;
  }

  boolean allowsHost(String value) {
    if (value == null) return false;
    return hosted ? host.equalsIgnoreCase(value) : LOCAL_HOSTS.contains(value);
  }

  boolean allowsOrigin(String value, Set<String> localOrigins) {
    return hosted ? origin.equals(value) : localOrigins.contains(value);
  }

  boolean projectCreation(String actor) {
    return !hosted || actor != null;
  }

  void requireActor(String actor) {
    if (actor == null) throw new ApiError(401, "AUTH_REQUIRED", "Sign in required");
  }
}
