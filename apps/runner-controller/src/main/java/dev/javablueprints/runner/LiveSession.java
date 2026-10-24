package dev.javablueprints.runner;

import static dev.javablueprints.verification.RunnerProtocol.*;
import java.io.ByteArrayOutputStream;
import java.util.*;
import java.util.concurrent.LinkedBlockingQueue;

/** Bounded input delivery and output snapshots for one isolated runtime. */
final class LiveSession {
    final LinkedBlockingQueue<InputFrame> input = new LinkedBlockingQueue<>(1024);
    final ByteArrayOutputStream stdout = new ByteArrayOutputStream();
    final ByteArrayOutputStream stderr = new ByteArrayOutputStream();
    private final Map<String, String> accepted = new HashMap<>();
    private int bytes;
    private boolean eof;

    LiveSession(int initialBytes) {bytes=initialBytes;}

    synchronized void accept(InputFrame frame) {
        id(frame.id());
        byte[] data = frame.data().decode(8192);
        String fingerprint = frame.data().sha256() + ":" + frame.eof();
        String previous = accepted.get(frame.id());
        if (previous != null) {
            if (!previous.equals(fingerprint)) throw new IllegalArgumentException("Input replay conflict");
            return;
        }
        if (eof || accepted.size() >= 1024 || bytes + data.length > MAX_OUTPUT || !input.offer(frame))
            throw new IllegalArgumentException("Input closed or limit exceeded");
        accepted.put(frame.id(), fingerprint);
        bytes += data.length;
        eof = frame.eof();
    }
}
