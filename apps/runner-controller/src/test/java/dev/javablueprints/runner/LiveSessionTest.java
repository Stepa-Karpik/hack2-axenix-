package dev.javablueprints.runner;

import static dev.javablueprints.verification.RunnerProtocol.*;
import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

class LiveSessionTest {
    @Test void replayIsIdempotentButConflictingReplayAndInputAfterEofAreRejected() {
        var session=new LiveSession(0);
        var line=new InputFrame("line",Bytes.text("Привет\n"),false);
        session.accept(line);session.accept(line);
        assertEquals(1,session.input.size());
        assertThrows(IllegalArgumentException.class,()->session.accept(new InputFrame("line",Bytes.text("different"),false)));
        var eof=new InputFrame("close",Bytes.text(""),true);
        session.accept(eof);session.accept(eof);
        assertEquals(2,session.input.size());
        assertThrows(IllegalArgumentException.class,()->session.accept(new InputFrame("late",Bytes.text("x"),false)));
    }
    @Test void initialAndLiveInputShareOneByteBudgetAndEachFrameIsBounded() {
        var session=new LiveSession(MAX_OUTPUT-1);
        session.accept(new InputFrame("one",Bytes.text("x"),false));
        assertThrows(IllegalArgumentException.class,()->session.accept(new InputFrame("two",Bytes.text("y"),false)));
        assertThrows(IllegalArgumentException.class,()->new LiveSession(0).accept(new InputFrame("big",Bytes.text("x".repeat(8193)),false)));
    }
    @Test void commandCountIsBoundedEvenWhenWriterHasDrainedQueue() {
        var session=new LiveSession(0);
        for(int i=0;i<1024;i++){session.accept(new InputFrame("line"+i,Bytes.text(""),false));session.input.poll();}
        assertThrows(IllegalArgumentException.class,()->session.accept(new InputFrame("extra",Bytes.text(""),false)));
    }
}
