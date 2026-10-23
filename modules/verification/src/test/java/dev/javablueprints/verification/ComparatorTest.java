package dev.javablueprints.verification;

import static dev.javablueprints.verification.RunnerProtocol.*;
import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import java.util.*;

class ComparatorTest {
    private Observation observation(String text,int exit,ExecutionOutcome outcome) {return new Observation("p","j","a","e","s",Phase.runtime,"terminal",outcome,exit,Bytes.text(text),Bytes.text(""),false,null,false);}
    private Comparison compare(List<Observation> base,List<Observation> candidate,Integer expected) {var c=new TestCase("c","",List.of(),expected,null,null);return Comparator.compare(List.of(c),List.of(new TestResult("c",base,candidate,false)),null,null);}
    @Test void exactStreamsAndExitMatchOnlyThreeFullObservations(){var a=observation("привет\n",0,ExecutionOutcome.exited);assertEquals(ComparisonOutcome.matched_on_tests,compare(Collections.nCopies(3,a),Collections.nCopies(3,a),null).outcome());var b=observation("привет \n",0,ExecutionOutcome.exited);assertEquals(ComparisonOutcome.mismatch,compare(Collections.nCopies(3,a),Collections.nCopies(3,b),null).outcome());assertEquals(ComparisonOutcome.inconclusive,compare(List.of(a),List.of(a),null).outcome());}
    @Test void nonzeroNeedsExplicitOracle(){var a=observation("",2,ExecutionOutcome.exited);assertEquals("nonzero_without_oracle",compare(Collections.nCopies(3,a),Collections.nCopies(3,a),null).reason());assertEquals(ComparisonOutcome.matched_on_tests,compare(Collections.nCopies(3,a),Collections.nCopies(3,a),2).outcome());}
    @Test void limitsAndNondeterminismNeverMatch(){for(var outcome:List.of(ExecutionOutcome.timeout,ExecutionOutcome.oom,ExecutionOutcome.output_limit,ExecutionOutcome.sandbox_error)){var a=observation("",0,outcome);assertEquals(ComparisonOutcome.inconclusive,compare(Collections.nCopies(3,a),Collections.nCopies(3,a),null).outcome());}var a=observation("1",0,ExecutionOutcome.exited);var b=observation("2",0,ExecutionOutcome.exited);assertEquals("nondeterministic",compare(List.of(a,b,a),List.of(a,b,a),null).reason());}
    @Test void rejectsEmptySuiteAndCorruptedBytes(){assertThrows(IllegalArgumentException.class,()->Comparator.compare(List.of(),List.of(),null,null));var bytes=Bytes.text("abc");assertThrows(IllegalArgumentException.class,()->new Bytes(bytes.base64(),3,"bad").decode(20));assertThrows(IllegalArgumentException.class,()->path("../A.java"));}
    @Test void caseVerdictsAndLaterMismatchSurviveEarlierLimit(){var timeout=observation("",0,ExecutionOutcome.timeout);var a=observation("a",0,ExecutionOutcome.exited);var b=observation("b",0,ExecutionOutcome.exited);var cases=List.of(new TestCase("c1","",List.of(),null,null,null),new TestCase("c2","",List.of(),null,null,null));var result=Comparator.compare(cases,List.of(new TestResult("c1",Collections.nCopies(3,timeout),Collections.nCopies(3,timeout),false),new TestResult("c2",Collections.nCopies(3,a),Collections.nCopies(3,b),false)),null,null);assertEquals(ComparisonOutcome.mismatch,result.outcome());assertFalse(result.coverageComplete());assertEquals(ComparisonOutcome.inconclusive,result.tests().getFirst().outcome());assertEquals(ComparisonOutcome.mismatch,result.tests().getLast().outcome());var matched=compare(Collections.nCopies(3,a),Collections.nCopies(3,a),null);assertTrue(matched.tests().getFirst().matched());}
    @Test void cleanupPendingCannotVerifyRuntimeOrCompilation(){
        var clean=observation("same",0,ExecutionOutcome.exited);
        var pending=new Observation("p","j","a","e","s",Phase.runtime,"terminal",ExecutionOutcome.exited,0,Bytes.text("same"),Bytes.text(""),false,null,true);
        var runtime=compare(List.of(clean,clean,clean),List.of(clean,clean,pending),null);
        assertEquals(ComparisonOutcome.inconclusive,runtime.outcome());assertFalse(runtime.coverageComplete());assertEquals(0,runtime.matched());assertTrue(runtime.tests().getFirst().reasons().contains("cleanup_pending"));
        var compile=new Observation("p","j","a","e","s",Phase.compile,"terminal",ExecutionOutcome.exited,0,Bytes.text(""),Bytes.text(""),false,"artifact",true);
        var result=Comparator.compare(List.of(new TestCase("c","",List.of(),0,null,null)),List.of(new TestResult("c",Collections.nCopies(3,clean),Collections.nCopies(3,clean),false)),compile,compile);
        assertEquals(ComparisonOutcome.inconclusive,result.outcome());assertEquals("cleanup_pending",result.reason());assertFalse(result.coverageComplete());assertEquals(0,result.matched());
    }
    @Test void argumentLimitsCountUtf8BytesAndRejectNul(){
        assertDoesNotThrow(()->arguments(List.of("Привет")));
        assertThrows(IllegalArgumentException.class,()->arguments(List.of("a\u0000b")));
        assertThrows(IllegalArgumentException.class,()->arguments(Collections.nCopies(9,"я".repeat(4000))));
        assertThrows(IllegalArgumentException.class,()->arguments(List.of("я".repeat(4097))));
    }
}
