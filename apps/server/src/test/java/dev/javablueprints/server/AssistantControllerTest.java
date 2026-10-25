package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class AssistantControllerTest {
  @Test
  void everyEndpointRequiresAuthenticatedAccountBeforeDataAccess() {
    var accounts = mock(Accounts.class);
    var service = mock(AssistantService.class);
    var r = new MockHttpServletRequest();
    var controller = new AssistantController(accounts, service);
    when(accounts.require(r)).thenThrow(new ApiError(401, "AUTH_REQUIRED", "Sign in required"));
    assertThrows(ApiError.class, () -> controller.status(r));
    assertThrows(ApiError.class, () -> controller.list(r));
    assertThrows(ApiError.class, () -> controller.create(r));
    assertThrows(ApiError.class, () -> controller.get(id(), r));
    assertThrows(ApiError.class, () -> controller.delete(id(), r));
    assertThrows(ApiError.class, () -> controller.send(id(), map("content", "test"), r));
    assertThrows(ApiError.class, () -> controller.act(id(), id(), map(), r));
    assertThrows(ApiError.class, () -> controller.cancel(id(), id(), r));
    assertThrows(
        ApiError.class, () -> controller.result(id(), id(), map("ok", true, "message", "test"), r));
    verifyNoInteractions(service);
  }
}
