package dev.javablueprints.server;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.forwardedUrl;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class WebRoutesTest {
  @Test void routedSettingsAndProfileFriendsHaveDirectNavigationFallback() throws Exception {
    var mvc = MockMvcBuilders.standaloneSetup(new WebRoutes()).build();
    for (String path : new String[]{"/settings/profile", "/settings/security", "/settings/appearance",
        "/settings/friends", "/settings/integrations", "/u/example/friends", "/profile/example/friends"})
      mvc.perform(get(path).accept(MediaType.TEXT_HTML)).andExpect(forwardedUrl("/index.html"));
  }
}
