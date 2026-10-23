package dev.javablueprints.server;

import static dev.javablueprints.verification.RunnerProtocol.*;
import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

class ExecutionGateTest {
  @Test
  void unresolvedCompilerCleanupCannotPermitProposalOrRuntime() {
    var clean =
        new Observation(
            "p",
            "j",
            "a",
            "e",
            "s",
            Phase.compile,
            "terminal",
            ExecutionOutcome.exited,
            0,
            Bytes.text(""),
            Bytes.text(""),
            false,
            "artifact",
            false);
    var pending =
        new Observation(
            "p",
            "j",
            "a",
            "e",
            "s",
            Phase.compile,
            "terminal",
            ExecutionOutcome.exited,
            0,
            Bytes.text(""),
            Bytes.text(""),
            false,
            "artifact",
            true);
    assertTrue(JobWorker.compilationPassed(clean));
    assertFalse(JobWorker.compilationPassed(pending));
  }
}
