package dev.javablueprints.engine;

import static org.junit.jupiter.api.Assertions.*;
import dev.javablueprints.engine.EngineModel.SourceBundle;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ParseDiagnosticTest {
  @Test void methodWithoutAClassIsAnInvalidAnalysisRatherThanAJobFailure() {
    String source = "static int test(int n) { return n+1; }";
    var result = new ProgramEngine().inspect(new SourceBundle("bare-method", Map.of("Main.java", source)));
    assertEquals("invalid", result.parseStatus());
    assertFalse(result.diagnostics().isEmpty());
    var diagnostic = result.diagnostics().getFirst();
    assertEquals("PARSE_ERROR", diagnostic.code());
    assertNotNull(diagnostic.sourceRange());
    assertEquals("Main.java", diagnostic.sourceRange().filePath());
    assertTrue(diagnostic.sourceRange().startOffset() >= 0);
    assertTrue(diagnostic.sourceRange().endOffset() <= source.length());
  }
}
