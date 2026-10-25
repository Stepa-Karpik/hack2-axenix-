package dev.javablueprints.server;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class HostingAccessTest {
  static final String ORIGIN = "https://java-blueprints.karpovprod.ru";

  @Test
  void localDefaultsPreserveLoopbackAndConfiguredOrigins() {
    var policy = new HostingAccess(false, "unused local URL", false);
    assertFalse(policy.hosted());
    for (String host : Set.of("localhost", "127.0.0.1", "::1", "[::1]"))
      assertTrue(policy.allowsHost(host));
    assertFalse(policy.allowsHost("java-blueprints.karpovprod.ru"));
    assertTrue(policy.allowsOrigin("http://localhost:5174", Set.of("http://localhost:5174")));
    assertTrue(policy.projectCreation(null));
  }

  @Test
  void canonicalHostAndOriginExcludeLocalAndUntrustedForwarding() throws Exception {
    var policy = new HostingAccess(true, ORIGIN + "/", true);
    assertTrue(policy.allowsHost("JAVA-BLUEPRINTS.KARPOVPROD.RU"));
    assertFalse(policy.allowsHost("localhost"));
    assertFalse(policy.allowsHost("java-blueprints.karpovprod.ru.evil.example"));
    assertFalse(policy.allowsOrigin("http://localhost:5174", Set.of("http://localhost:5174")));
    assertFalse(policy.allowsOrigin(ORIGIN + ".evil.example", Set.of()));
    assertTrue(policy.allowsOrigin(ORIGIN, Set.of()));
    assertFalse(policy.projectCreation(null));
    assertTrue(policy.projectCreation("account"));
    var request = request("GET");
    request.setServerName("evil.example");
    request.addHeader("X-Forwarded-Host", "java-blueprints.karpovprod.ru");
    assertEquals(403, filter(policy, request));
  }

  @Test
  void insecureOrNonCanonicalHostedConfigurationFailsClosed() {
    assertThrows(IllegalArgumentException.class, () -> new HostingAccess(true, ORIGIN, false));
    for (String url :
        Set.of(
            "http://java-blueprints.karpovprod.ru",
            "https://user@java-blueprints.karpovprod.ru",
            ORIGIN + "/api",
            ORIGIN + "?query",
            ORIGIN + "#fragment",
            ORIGIN + ":8081",
            "https://*.karpovprod.ru",
            "https://",
            "not a URI"))
      assertThrows(IllegalArgumentException.class, () -> new HostingAccess(true, url, true), url);
  }

  @Test
  void safeCanonicalRequestNeedsNoOriginButForeignOriginFails() throws Exception {
    var policy = new HostingAccess(true, ORIGIN, true);
    assertEquals(200, filter(policy, request("GET")));
    var foreign = request("GET");
    foreign.addHeader("Origin", "https://evil.example");
    assertEquals(403, filter(policy, foreign));
  }

  @Test
  void unsafeCanonicalRequestStillRequiresOriginAndExactSessionCsrf() throws Exception {
    var policy = new HostingAccess(true, ORIGIN, true);
    var request = request("POST");
    request.getSession().setAttribute("csrf", "expected");
    request.addHeader("X-CSRF-Token", "expected");
    assertEquals(403, filter(policy, request));
    request.addHeader("Origin", ORIGIN);
    assertEquals(200, filter(policy, request));
    request.removeHeader("X-CSRF-Token");
    request.addHeader("X-CSRF-Token", "wrong");
    assertEquals(403, filter(policy, request));
  }

  static MockHttpServletRequest request(String method) {
    var request = new MockHttpServletRequest(method, "/api/v1/projects");
    request.setServerName("java-blueprints.karpovprod.ru");
    return request;
  }

  static int filter(HostingAccess policy, MockHttpServletRequest request) throws Exception {
    var response = new MockHttpServletResponse();
    var invoked = new AtomicBoolean();
    new LocalSecurity("http://localhost:5174", policy)
        .doFilter(request, response, (r, s) -> invoked.set(true));
    assertEquals(response.getStatus() == 200, invoked.get());
    return response.getStatus();
  }
}
