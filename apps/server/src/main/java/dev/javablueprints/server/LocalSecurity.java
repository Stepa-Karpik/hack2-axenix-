package dev.javablueprints.server;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class LocalSecurity implements Filter {
  private final Set<String> origins;

  public LocalSecurity(@Value("${jb.origins}") String values) {
    origins = Set.of(values.split(","));
  }

  public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
      throws IOException, ServletException {
    var r = (HttpServletRequest) req;
    var s = (HttpServletResponse) res;
    s.setHeader("X-Content-Type-Options", "nosniff");
    s.setHeader("Cache-Control", "no-store");
    s.setHeader("X-Frame-Options", "DENY");
    String host = r.getServerName();
    if (!Set.of("localhost", "127.0.0.1", "[::1]", "::1").contains(host)) {
      deny(s, 403, "FORBIDDEN");
      return;
    }
    String origin = r.getHeader("Origin");
    if (origin != null && !origins.contains(origin)) {
      deny(s, 403, "FORBIDDEN");
      return;
    }
    if (!Set.of("GET", "HEAD", "OPTIONS").contains(r.getMethod())) {
      var session = r.getSession(false);
      String expected = session == null ? null : (String) session.getAttribute("csrf");
      if (origin == null
          || expected == null
          || !java.security.MessageDigest.isEqual(
              expected.getBytes(java.nio.charset.StandardCharsets.UTF_8),
              Objects.toString(r.getHeader("X-CSRF-Token"), "")
                  .getBytes(java.nio.charset.StandardCharsets.UTF_8))) {
        deny(s, 403, "CSRF_INVALID");
        return;
      }
    }
    chain.doFilter(req, res);
  }

  private void deny(HttpServletResponse s, int status, String code) throws IOException {
    s.setStatus(status);
    s.setContentType("application/json");
    s.getWriter()
        .write(
            "{\"error\":{\"code\":\""
                + code
                + "\",\"message\":\"Local access check"
                + " failed\",\"details\":[]},\"meta\":{\"requestId\":\""
                + UUID.randomUUID()
                + "\"}}");
  }
}
