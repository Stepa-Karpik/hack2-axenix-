package dev.javablueprints.runner;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ResourceMetricsTest {
    @Test void kernelPeakRequiresOnePositiveDecimalValue() {
        assertEquals(15728640L,DockerSandbox.peakBytes("15728640\n"));
        for(String value:new String[]{"","0","-1","max","NaN","12\n34","9223372036854775808","measured=12"})
            assertNull(DockerSandbox.peakBytes(value),value);
    }
}
