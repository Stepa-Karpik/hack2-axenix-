package dev.javablueprints.server;
import static org.junit.jupiter.api.Assertions.*;
import dev.javablueprints.engine.EngineModel.RenameLocal;
import java.util.Map;
import org.junit.jupiter.api.Test;
class LocalRenamePayloadTest {
  private Map<String,Object> command(String intent, Map<String,Object> payload) {return Map.of("operation","rename_local","intent",intent,"payload",payload);}
  @Test void onlyStrictNameAndPreservingIntentAreAccepted() {
    assertEquals(new RenameLocal("сумма"),ApiController.editPayload(command("preserve_behavior",Map.of("newName","сумма"))));
    assertThrows(ApiError.class,()->ApiController.editPayload(command("semantic_edit",Map.of("newName","total"))));
    assertThrows(ApiError.class,()->ApiController.editPayload(command("preserve_behavior",Map.of("newName","total","source","int total"))));
    for(String name:new String[]{"","bad-name","class","_","yield"," total","x".repeat(101)}) assertThrows(ApiError.class,()->ApiController.editPayload(command("preserve_behavior",Map.of("newName",name))));
  }
}
