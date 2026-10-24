public class Main {
  static class Resource implements AutoCloseable {
    final String name;
    final Throwable failure;
    Resource(String name, Throwable failure) {
      this.name = name;
      this.failure = failure;
    }
    public void close() throws Exception {
      System.out.print("-" + name);
      if (failure instanceof Error) throw (Error) failure;
      if (failure != null) throw (Exception) failure;
    }
  }
  static Resource acquire(String name, boolean fail, Throwable closeFailure) {
    System.out.print("+" + name);
    if (fail) throw new IllegalStateException("init" + name);
    return new Resource(name, closeFailure);
  }
  static RuntimeException problem(String name) {
    return new IllegalArgumentException(name);
  }
  static void describe(Throwable failure) {
    System.out.print("|" + failure.getClass().getSimpleName() + ":" + failure.getMessage() + "[");
    for (Throwable suppressed : failure.getSuppressed()) System.out.print(suppressed.getMessage() + ";");
    System.out.print("]");
  }
  static void ordered() throws Exception {
    try (Resource a = acquire("A", false, null); Resource b = acquire("B", false, null)) {
      System.out.print("body");
    }
    System.out.print("done");
  }
  static void nullable() throws Exception {
    try (Resource a = acquire("A", false, null); Resource absent = null; Resource c = acquire("C", false, null)) {
      System.out.print("body");
    }
  }
  static void initializer(boolean closeFails) {
    try (Resource a = acquire("A", false, closeFails ? problem("closeA") : null);
         Resource b = acquire("B", true, null); Resource c = acquire("C", false, null)) {
      System.out.print("unreachable");
    } catch (Exception failure) { describe(failure); }
  }
  static void primary(boolean bodyThrows) {
    try (Resource a = acquire("A", false, problem("closeA")); Resource b = acquire("B", false, problem("closeB"))) {
      System.out.print("body");
      if (bodyThrows) throw problem("body");
    } catch (Exception failure) { describe(failure); }
  }
  static int returning(boolean closeFails) throws Exception {
    try (Resource a = acquire("A", false, closeFails ? problem("closeA") : null)) {
      System.out.print("return");
      return 7;
    }
  }
  static void returnCase(boolean closeFails) {
    try { System.out.print(returning(closeFails)); }
    catch (Exception failure) { describe(failure); }
  }
  static void jumping(boolean continuing, boolean closeFails) {
    for (int i = 0; i < 2; i++) {
      try (Resource a = acquire("A", false, closeFails ? problem("closeA") : null)) {
        System.out.print(i);
        if (continuing) continue;
        break;
      } catch (Exception failure) { System.out.print("caught"); }
      System.out.print("tail");
    }
    System.out.print("done");
  }
  static void nested() {
    try (Resource a = acquire("A", false, problem("closeA"))) {
      try (Resource b = acquire("B", false, problem("closeB"))) {
        System.out.print("body");
        throw problem("body");
      }
    } catch (Exception failure) { describe(failure); }
    finally { System.out.print("finally"); }
  }
  static void existing() throws Exception {
    Resource a = acquire("A", false, null);
    final Resource b = acquire("B", false, null);
    try (a; b) { System.out.print("body"); }
  }
  static void selfSuppression() {
    RuntimeException same = problem("same");
    try (Resource a = acquire("A", false, same)) {
      System.out.print("body");
      throw same;
    } catch (Exception failure) {
      System.out.print("|" + failure.getClass().getSimpleName() + ":cause=" + (failure.getCause() == same));
      System.out.print(":suppressed=" + failure.getSuppressed().length);
    }
  }
  static class Quiet extends Exception {
    Quiet() { super("quiet", null, false, false); }
  }
  static void suppressionDisabled() {
    try (Resource a = acquire("A", false, problem("closeA")); Resource b = acquire("B", false, problem("closeB"))) {
      System.out.print("body");
      throw new Quiet();
    } catch (Exception failure) { describe(failure); }
  }
  static void checked() {
    try (Resource a = acquire("A", false, new java.io.IOException("checked"))) {
      System.out.print("body");
    } catch (Exception failure) { describe(failure); }
  }
  static void errorPrimary() {
    try (Resource a = acquire("A", false, new AssertionError("closeError"))) {
      System.out.print("body");
      throw new AssertionError("bodyError");
    } catch (Throwable failure) { describe(failure); }
  }
  public static void main(String[] args) throws Exception {
    switch (args[0]) {
      case "ordered": ordered(); break;
      case "null": nullable(); break;
      case "init": initializer(Boolean.parseBoolean(args[1])); break;
      case "primary": primary(Boolean.parseBoolean(args[1])); break;
      case "return": returnCase(Boolean.parseBoolean(args[1])); break;
      case "jump": jumping(Boolean.parseBoolean(args[1]), Boolean.parseBoolean(args[2])); break;
      case "nested": nested(); break;
      case "existing": existing(); break;
      case "self": selfSuppression(); break;
      case "disabled": suppressionDisabled(); break;
      case "checked": checked(); break;
      case "error": errorPrimary(); break;
      default: throw new IllegalArgumentException("unknown case");
    }
  }
}
