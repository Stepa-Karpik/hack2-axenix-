# Mandatory Java source acceptance fixture

`Main.java` is a canonical LF, UTF-8 public synthetic source bundle (1070 lines). It combines the mandatory language/library cases below with 36 distinct bounded algorithms and their fixed edge assertions. There is no generated padding and no dependency beyond the JDK. Compile and run it **only in the isolated Linux runner**. Trusted application tests parse and prepare detached edits; they never compile or execute this source on the Windows host.

`oracles.json` records 21 independent expected observations. Launch class `Main`, use each entry's `argv` and exact `stdinUtf8`, and compare stdout/stderr/exit exactly. Each case runs in a fresh JVM; initialization effects must not leak between cases. Expected formatting assumes the configured Linux runner's LF newline and explicit `Locale.ROOT`. Do not derive expected values from actual outputs.

| Mode | Contract and independent expectation |
|---|---|
| dispatch | Parent/child initialization, constructor calls, interface dispatch and overload selection: `BSbCsD\|4:13:4:6` |
| numeric | Java int/long wrap, byte cast, promotion, Cyrillic char, floating cast and null unboxing/NPE |
| arrays | Jagged arrays, alias mutation, empty array, bounds and null exceptions: `12:2:1:0:BN` |
| conditions true/false | Exactly one logged tick; separate eager post/pre increment outcomes |
| strings | String/StringBuilder/Math/wrappers and Cyrillic: `Привет:15:6:true:65` |
| console | Exact UTF-8 three-token/nextLine/EOF boundary; empty and mismatch cases are separate |
| format | Explicit Locale.ROOT Formatter and printf, Cyrillic, padding and precise decimal output |
| collections | Iterator.remove preserves duplicates/order; map replacement preserves insertion order; explicit stale iterator CME |
| comparator | Named Comparator uses descending primary, ascending secondary and stable exact ties |
| optional | `orElse` fallback is eager for both present/empty cases: side effect count remains1 |
| exceptions | Checked/runtime/normal paths retain finally: `TCF`, `TUF`, `TNF` |
| initializers | Parent static marker; child static field/block/field once; two instance field/block/field and delegated constructor streams |
| loops | for continue sum8, while3, do-first1, enhanced9, nested break/continue12, nested switch fallthrough13 |
| anonymous-comparator | Same stable order as named comparator; exact unchanged preservation only for this unsupported nested semantic domain |
| algorithms | 36 diverse families; 33 families have4 assertions, three sort families have2: `algorithms:138` |

The initializer oracle is derived from superclass initialization preceding child static initialization, then parent instance/constructor followed by the child's declaration-order initializers and noarg/delegating constructor chain. The second construction repeats only the instance stream. Each marker returns1, so first.x + second.y is2 and the interface constant is7. This behavior oracle is independent of the initializer **source projection**, which does not claim to construct a lifecycle CFG.

Algorithm assertions cover search and insertion bounds, Euclidean GCD/LCM, Fibonacci/factorial/primes, digit handling, palindrome/rotation/prefix/window, two-sum/dedup/merge, three sorting algorithms, Unicode BMP text/word counts/frequencies, bracket stacks, matrix transpose/product, recursive flood fill, edit distance, increasing subsequence, coin change, maximum subarray, two's-complement bit count, polynomial evaluation and next permutation. Fixtures are bounded; these are concrete cases, not universal algorithm proofs. No lambda is required; anonymous Comparator preservation is recorded separately from named Comparator semantic support.

`MandatoryScopeAcceptanceTest` checks real parsing, exact unchanged bytes, declaration/source binding, separate initializer streams, detached same-expression initializer edit, an actual selected array index and a loop-bound edit. All candidates remain compilation-not-requested and unverified until the existing isolated whole-bundle compilation and exact immutable comparison/apply gate succeeds.

Case-constant editing, arbitrary refactoring, full semantic support in anonymous classes, universal library behavior, container resource enforcement, UI responsiveness and live runner results are not established by these parser checks. Runtime and UI evidence must be recorded separately on the exact final source version.
