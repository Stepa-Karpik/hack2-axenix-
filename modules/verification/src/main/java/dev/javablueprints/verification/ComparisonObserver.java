package dev.javablueprints.verification;

import dev.javablueprints.verification.RunnerProtocol.Observation;
import dev.javablueprints.verification.RunnerProtocol.TestResult;

/** Execution facts only; progress cannot authorize applying a source change. */
public interface ComparisonObserver {
    enum Stage { compile_base, compile_candidate, tests }
    enum Side { base, candidate }
    ComparisonObserver NONE = new ComparisonObserver() {};

    default void phase(Stage stage) {}
    default void caseStarted(String caseId) {}
    default void observed(String caseId, Side side, int index, Observation execution) {}
    default void caseFinished(TestResult result) {}
}
