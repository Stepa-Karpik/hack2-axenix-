package dev.javablueprints.verification;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static dev.javablueprints.verification.RunnerProtocol.*;
import java.util.*;

class MethodContractTest {
    String result="{\"complete\":true,\"completion\":\"return\",\"returnValue\":7,\"exception\":null,\"argumentsAfter\":[2]}";
    Observation observation(String channel,String out) {return new Observation("p","j","a",UUID.randomUUID().toString(),"hash",Phase.runtime,"terminal",ExecutionOutcome.exited,0,Bytes.text(out),Bytes.text(""),false,null,false,null,channel==null?null:Bytes.text(channel));}
    @Test void typedOracleAndRawStreamsRemainAuthoritative() {
        var input=new TestCase("case","",List.of(),0,"", "",result);
        var b=observation(result,"");var c=observation(result,"");
        var comparison=Comparator.compare(List.of(input),List.of(new TestResult("case",List.of(b,b,b),List.of(c,c,c),false)),null,null,true);
        assertEquals(ComparisonOutcome.matched_on_tests,comparison.outcome());
        var wrong=new TestCase("case","",List.of(),0,"","",result.replace(":7",":8"));
        assertEquals(ComparisonOutcome.mismatch,Comparator.compare(List.of(wrong),comparison.tests(),null,null,true).outcome());
        assertFalse(MethodContract.equal(b,observation(result,"side effect")));
    }
    @Test void systemExitMissingResultAndTruncatedExceptionGraphCannotMatch() {
        for(String channel:new String[]{null,"{\"complete\":false}","{}","not json"}) {
            var a=observation(channel,"");var input=new TestCase("case","",List.of(),0,null,null,result);
            var comparison=Comparator.compare(List.of(input),List.of(new TestResult("case",List.of(a,a,a),List.of(a,a,a),false)),null,null,true);
            assertEquals(ComparisonOutcome.inconclusive,comparison.outcome());assertTrue(comparison.reason().contains("method_result_missing_or_incomplete"));
        }
    }
    @Test void consoleExactPolicyDoesNotReadOrNormalizeMethodChannel() {
        var a=observation(null,"console");var b=observation(result,"console");
        assertTrue(Comparator.equal(a,b));
        assertNotEquals(PROFILE_HASH,MethodContract.PROFILE_HASH);
    }
}
