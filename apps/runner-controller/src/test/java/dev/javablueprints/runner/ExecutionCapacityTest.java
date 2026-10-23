package dev.javablueprints.runner;
import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
class ExecutionCapacityTest {
 @Test void retentionFitsMaximumSupportedSuiteIncludingBothCompilers(){
  int maximumCases=100,observationsPerSide=3,versions=2;
  int fullSuiteExecutions=versions+maximumCases*observationsPerSide*versions;
  assertTrue(RunnerController.MAX_RETAINED_EXECUTIONS>=fullSuiteExecutions,"One supported full suite must fit without evicting its execution handles");
  assertTrue(RunnerController.MAX_RETAINED_EXECUTIONS<=2048,"Retention must remain explicitly bounded");
 }
}
