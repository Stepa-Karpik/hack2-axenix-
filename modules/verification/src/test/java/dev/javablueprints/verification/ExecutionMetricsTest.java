package dev.javablueprints.verification;

import org.junit.jupiter.api.Test;
import static dev.javablueprints.verification.RunnerProtocol.*;
import static org.junit.jupiter.api.Assertions.*;

class ExecutionMetricsTest {
    @Test void optionalMetricsRetainOldReportsAndRejectInventedNegativeValues() throws Exception {
        var old=new Observation("p","j","a","e","s",Phase.runtime,"terminal",ExecutionOutcome.exited,0,Bytes.text(""),Bytes.text(""),false,null,false);
        var json=(com.fasterxml.jackson.databind.node.ObjectNode)JSON.valueToTree(old);json.remove("metrics");
        assertNull(JSON.treeToValue(json,Observation.class).metrics());
        var metrics=new ExecutionMetrics(42,15728640L,"cgroup-v2-container-lifetime-including-setup-and-probe");
        assertEquals(metrics,JSON.readValue(JSON.writeValueAsBytes(metrics),ExecutionMetrics.class));
        assertNull(new ExecutionMetrics(0,null,"cgroup-v2-container-lifetime-including-setup-and-probe").containerPeakMemoryBytes());
        assertThrows(IllegalArgumentException.class,()->new ExecutionMetrics(-1,1L,metrics.memoryScope()));
        assertThrows(IllegalArgumentException.class,()->new ExecutionMetrics(1,0L,metrics.memoryScope()));
        assertThrows(IllegalArgumentException.class,()->new ExecutionMetrics(1,1L,"JVM-heap-peak"));
    }
}
