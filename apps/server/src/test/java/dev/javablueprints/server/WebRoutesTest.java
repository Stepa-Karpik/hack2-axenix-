package dev.javablueprints.server;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class WebRoutesTest {
  final org.springframework.test.web.servlet.MockMvc mvc = MockMvcBuilders.standaloneSetup(new WebRoutes()).build();

  @Test void rootAlwaysForwardsToStandaloneLandingIncludingAuthenticatedSessionAndQuery() throws Exception {
    mvc.perform(get("/").accept("text/html")).andExpect(status().isOk()).andExpect(forwardedUrl("/landing/index.html"));
    mvc.perform(get("/?github=signup_success").accept("text/html").sessionAttr("accountId", "fixture-account"))
        .andExpect(status().isOk()).andExpect(forwardedUrl("/landing/index.html"));
  }

  @Test void applicationRoutesKeepReactEntryPoint() throws Exception {
    for (String path : new String[]{"/projects", "/github/complete", "/login", "/register", "/projects/fixture", "/settings/security"}) {
      mvc.perform(get(path).accept("text/html")).andExpect(status().isOk()).andExpect(forwardedUrl("/index.html"));
    }
  }
}
