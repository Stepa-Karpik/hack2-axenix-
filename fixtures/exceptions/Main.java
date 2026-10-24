public class Main {
  static void ordered(int mode) {
    try {
      System.out.print("T");
      if (mode == 0) throw new IllegalArgumentException();
      if (mode == 1) throw new NullPointerException();
      if (mode == 2) throw new IllegalStateException();
      System.out.print("N");
    } catch (IllegalArgumentException | NullPointerException first) {
      System.out.print("M");
    } catch (RuntimeException second) {
      System.out.print("R");
    } finally {
      System.out.print("F");
    }
  }
  static int nested(boolean override) {
    try {
      try {
        System.out.print("A");
        return 7;
      } finally {
        System.out.print("I");
        if (override) return 9;
      }
    } finally {
      System.out.print("O");
    }
  }
  static void handler() {
    try {
      try {
        throw new IllegalArgumentException();
      } catch (IllegalArgumentException first) {
        System.out.print("C");
        throw new IllegalStateException();
      } catch (RuntimeException sibling) {
        System.out.print("S");
      } finally {
        System.out.print("I");
      }
    } catch (IllegalStateException outer) {
      System.out.print("O");
    } finally {
      System.out.print("F");
    }
  }
  static void jumps() {
    for (int i = 0; i < 3; i++) {
      try {
        if (i == 0) continue;
        if (i == 1) break;
        System.out.print("X");
      } finally {
        System.out.print(i);
      }
    }
    System.out.print("J");
  }
  static boolean explode() {
    System.out.print("E");
    throw new IllegalArgumentException();
  }
  static void shortCircuit(boolean left) {
    try {
      if (left && explode()) System.out.print("bad");
      System.out.print("N");
    } catch (IllegalArgumentException failure) {
      System.out.print("C");
    } finally {
      System.out.print("F");
    }
  }
  static void checkedHelper() throws java.io.IOException {
    System.out.print("E");
    throw new java.io.IOException("checked");
  }
  static void checked() {
    try {
      checkedHelper();
    } catch (java.io.IOException failure) {
      System.out.print("C");
    } finally {
      System.out.print("F");
    }
  }
  static class Problem extends Exception {
    Problem(String message) { super(message); }
  }
  static void customChecked() {
    try {
      throw new Problem("x");
    } catch (Problem failure) {
      System.out.print(failure.getMessage());
    } finally {
      System.out.print("F");
    }
  }
  static void nullThrow() {
    try {
      throw null;
    } catch (NullPointerException failure) {
      System.out.print("N");
    } finally {
      System.out.print("F");
    }
  }
  static int finallyThrow() {
    try {
      try {
        System.out.print("A");
        return 7;
      } finally {
        System.out.print("F");
        throw new IllegalStateException();
      }
    } catch (IllegalStateException failure) {
      System.out.print("C");
      return 9;
    }
  }
  static int explodeInt() {
    System.out.print("E");
    throw new IllegalStateException();
  }
  static int failingCatchReturn() {
    try {
      try {
        throw new IllegalArgumentException();
      } catch (IllegalArgumentException failure) {
        return explodeInt();
      } finally {
        System.out.print("I");
      }
    } catch (IllegalStateException outer) {
      System.out.print("O");
      return 4;
    }
  }
  static int finallyJump() {
    for (int i = 0; i < 3; i++) {
      try {
        System.out.print(i);
        return 7;
      } finally {
        if (i == 0) continue;
        if (i == 1) break;
      }
    }
    return 9;
  }
  public static void main(String[] args) {
    switch (args[0]) {
      case "ordered": ordered(Integer.parseInt(args[1])); break;
      case "nested": System.out.print(nested(Boolean.parseBoolean(args[1]))); break;
      case "handler": handler(); break;
      case "jumps": jumps(); break;
      case "short": shortCircuit(Boolean.parseBoolean(args[1])); break;
      case "checked": checked(); break;
      case "custom-checked": customChecked(); break;
      case "null-throw": nullThrow(); break;
      case "finally-throw": System.out.print(finallyThrow()); break;
      case "catch-return-throw": System.out.print(failingCatchReturn()); break;
      case "finally-jump": System.out.print(finallyJump()); break;
      default: throw new IllegalArgumentException("unknown case");
    }
  }
}
