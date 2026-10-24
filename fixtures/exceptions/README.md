# Exception acceptance fixture

`oracles.json` contains hand-derived exact stdout. All cases require empty stderr and exit code 0; no baseline run is used to create expected output.

- Ordered catches print T before a throw. Either alternative in the first multi-catch prints M; IllegalStateException reaches the later RuntimeException catch and prints R. A normal body prints N. Finally prints F in every case.
- Nested return evaluates 7 before either cleanup, then prints I and O. An inner-finally return replaces the pending value with 9. Main prints the surviving value only after both finalizers complete.
- The handler prints C, throws IllegalStateException, and runs inner cleanup I. Sibling handlers are outside that handler's exception scope, so outer catch prints O and outer cleanup prints F: CIOF.
- Continue at i=0 runs cleanup 0 before update. Break at i=1 runs cleanup 1 before leaving the loop. The post-loop marker is J: 01J.
- False left operand skips explode, giving normal N then cleanup F. True invokes explode, prints E and throws, then catch C and cleanup F: ECF.
- A helper declared with throws IOException prints E and throws a checked exception. Its caller catches it with C and cleans up with F: ECF.
- A custom checked Problem carries the message x; catch prints that message and finally prints F: xF.
- Throwing null produces NullPointerException; its catch prints N and finally prints F: NF.
- An inner return evaluates 7 after printing A. Finally prints F and throws, replacing that pending return; outer catch prints C and returns 9, which main prints: AFC9.
- A catch return expression calls explodeInt, which prints E and throws before a return value exists. Inner finally prints I, then outer catch prints O and returns 4: EIO4.
- A pending return after printing 0 is overridden by finally's continue; the next pending return after printing 1 is overridden by finally's break. The post-loop return is 9: 019.

There are sixteen independent cases. Three base and three candidate executions per case give 96 runtime observations.

Only the server Docker runner may compile/execute this fixture. Browser tests create uniquely named disposable project contexts and never replace an existing project head. Equivalent candidate edits parenthesize the M literal in catch and F literal in finally; exact original and candidate source text are checked.
