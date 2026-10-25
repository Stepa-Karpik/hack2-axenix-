package dev.javablueprints.server;

import static org.junit.jupiter.api.Assertions.*;

import dev.javablueprints.engine.EngineModel.ExtractMethod;
import dev.javablueprints.engine.EngineModel.DecomposeClass;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ExtractMethodPayloadTest {
  @Test
  void classDecompositionRequiresStrictNameAndBehaviorIntent() {
    assertEquals(new DecomposeClass("EvenTotals"), ApiController.editPayload(Map.of("operation", "decompose_class", "intent", "preserve_behavior", "payload", Map.of("className", "EvenTotals"))));
    for (String name : new String[] {"", "bad/name", "class", "record", " EvenTotals", "X".repeat(81), "Класс"}) {
      assertThrows(ApiError.class, () -> ApiController.editPayload(Map.of("operation", "decompose_class", "intent", "preserve_behavior", "payload", Map.of("className", name))));
    }
    assertThrows(ApiError.class, () -> ApiController.editPayload(Map.of("operation", "decompose_class", "intent", "semantic_edit", "payload", Map.of("className", "EvenTotals"))));
    assertThrows(ApiError.class, () -> ApiController.editPayload(Map.of("operation", "decompose_class", "intent", "preserve_behavior", "payload", Map.of("className", "EvenTotals", "source", "class X {}"))));
  }
  private Map<String, Object> command(String intent, Map<String, Object> payload) {
    return Map.of("operation", "extract_method", "intent", intent, "payload", payload);
  }

  @Test
  void requiresBehaviorPreservationAndExactAnchorPayload() {
    var payload = Map.<String, Object>of("methodName", "calculate", "endNodeId", "end");
    assertEquals(new ExtractMethod("calculate", "end"), ApiController.editPayload(command("preserve_behavior", payload)));
    assertThrows(ApiError.class, () -> ApiController.editPayload(command("semantic_edit", payload)));
    assertThrows(ApiError.class, () -> ApiController.editPayload(command("preserve_behavior", Map.of("methodName", "calculate", "endNodeId", "end", "startOffset", 0))));
    assertThrows(ApiError.class, () -> ApiController.editPayload(command("preserve_behavior", Map.of("methodName", "calculate"))));
  }

  @Test
  void rejectsInvalidOrReservedNamesWithoutRewritingThem() {
    for (String name : new String[] {"", "bad-name", "class", "return", "_", "record", "yield", " calculate", "x".repeat(101)}) {
      assertThrows(ApiError.class, () -> ApiController.editPayload(command("preserve_behavior", Map.of("methodName", name, "endNodeId", "end"))), name);
    }
    assertEquals(new ExtractMethod("счёт", "end"), ApiController.editPayload(command("preserve_behavior", Map.of("methodName", "счёт", "endNodeId", "end"))));
  }
}
