package dev.javablueprints.server;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.forwardedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class WebRoutesTest {
  final MockMvc mvc = MockMvcBuilders.standaloneSetup(new WebRoutes()).build();

  @Test
  void explicitApplicationRoutesForwardHtmlRequests() throws Exception {
    for (String path : List.of(
        "/projects/project-id", "/projects/project-id/runs/run-id",
        "/login", "/register", "/forgot-password", "/reset-password", "/verify-email",
        "/auth/login", "/auth/register", "/auth/forgot-password", "/auth/reset-password", "/auth/verify-email",
        "/settings", "/account", "/friends", "/u/alice", "/profile/alice")) {
      mvc.perform(get(path).accept(MediaType.TEXT_HTML))
          .andExpect(status().isOk())
          .andExpect(forwardedUrl("/index.html"));
    }
    mvc.perform(get("/reset-password?token=opaque-link-token").accept(MediaType.TEXT_HTML))
        .andExpect(status().isOk())
        .andExpect(forwardedUrl("/index.html"));
  }

  @Test
  void apiAssetsAndUnknownRoutesAreNeverApplicationFallbacks() throws Exception {
    for (String path : List.of(
        "/api/v1/session", "/api/v1/auth/login", "/api/v1/profile", "/api/v1/users/alice",
        "/assets/missing.js", "/brand-lockup.png", "/unknown", "/auth/unknown", "/u/alice/private")) {
      mvc.perform(get(path).accept(MediaType.TEXT_HTML))
          .andExpect(status().isNotFound())
          .andExpect(forwardedUrl(null));
    }
    mvc.perform(get("/login").accept(MediaType.APPLICATION_JSON))
        .andExpect(status().isNotAcceptable())
        .andExpect(forwardedUrl(null));
  }
}
