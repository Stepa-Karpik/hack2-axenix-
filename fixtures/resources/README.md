# Try-with-resources acceptance fixture

`oracles.json` contains eighteen manually derived Java 21 stdout expectations. Every case has empty stderr and exits 0 because the fixture catches the deliberately thrown failures. The expectations were written without compiling/running the input Java and without consulting analyzer or baseline output.

`+A` marks initialization of resource A; `-A` marks its close. The description after `|` prints the caught type, message, and suppressed messages in their recorded order. Semicolons separate suppressed messages.

| Cases | Derivation |
| --- | --- |
| left-to-right-reverse-close | Initialize A then B, print body, close B then A, print done. |
| null-skip | Initialize A and C around a null resource. Close C then A; the null resource is skipped. |
| later-initializer-failure | B initialization throws after its marker. Only acquired A closes. C initialization and body never execute. |
| initializer-primary-close-suppressed | Same sequence; initB remains primary and closeA becomes suppressed. |
| body-primary-two-suppressed | Body remains primary. B closes first, followed by A, so suppression order is closeB then closeA. |
| normal-close-primary | With no body exception, B's failure becomes primary and A's is suppressed. |
| return-preserved / close-overrides-return | Return value 7 is evaluated before cleanup. Successful cleanup preserves it; throwing cleanup replaces the pending return. |
| break-preserved / continue-preserved | Successful cleanup preserves the jump: break exits after iteration 0; continue advances through iterations 0 and 1. Neither reaches tail. |
| close-overrides-break / close-overrides-continue | A close failure replaces the jump, so catch runs and tail becomes reachable on both iterations. |
| nested-before-catch-finally | Inner B closes then outer A closes before the associated catch prints the body exception and both suppressed failures. Explicit finally prints last. |
| existing-effectively-final | Java 9 resource references use an effectively final local A and an explicitly final local B. Both were acquired before entering try; close order is B then A. |
| self-suppression | Body and close throw the identical object. addSuppressed rejects self-suppression with IllegalArgumentException; its cause is the original object and its suppressed array is empty. No VM-dependent exception message is asserted. |
| suppression-disabled | Quiet's four-argument superclass constructor disables suppression. Both close operations still occur, but Quiet's suppressed array stays empty. |
| checked-close | A checked IOException thrown by close replaces the body's normal completion. |
| error-primary-and-close | Error participates in the same primary/suppressed protocol: bodyError remains primary and closeError is suppressed. |

The rules follow [JLS 21 §14.20.3](https://docs.oracle.com/javase/specs/jls/se21/html/jls-14.html#jls-14.20.3), including nested translation for multiple resources, and the [Throwable suppression contract](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Throwable.html#addSuppressed(java.lang.Throwable)).

The browser/API acceptance test creates a unique guest project, proposes an equivalent parenthesized literal inside a resource body, checks exact source preservation, and submits a real comparison suite to the Docker Java 21 runner. Eighteen cases × (three base + three candidate executions) produce 108 independently checked runtime observations. Only the server Docker runner may compile or execute this fixture. Tests never modify an existing project head or send email.
