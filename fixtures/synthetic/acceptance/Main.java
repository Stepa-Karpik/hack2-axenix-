import java.nio.charset.StandardCharsets;
import java.util.*;

public class Main {
  static int effects;
  public static void main(String[] args) throws Exception {
    String mode = args.length > 1 ? args[1] : "";
    switch (args[0]) {
      case "dispatch": dispatch(); break;
      case "numeric": numeric(); break;
      case "arrays": arrays(); break;
      case "conditions": conditions(Boolean.parseBoolean(mode)); break;
      case "strings": strings(); break;
      case "console": console(mode); break;
      case "format": formatting(); break;
      case "collections": collections(); break;
      case "comparator": comparator(); break;
      case "optional": optional(mode); break;
      case "exceptions": exceptions(Integer.parseInt(mode)); break;
      default: throw new IllegalArgumentException("Unknown fixture");
    }
  }
  static void dispatch() {
    Base object = new Child();
    Contract contract = object;
    System.out.println("|" + object.value(2) + ":" + object.value(Integer.valueOf(3)) + ":" + Child.count + ":" + contract.value(3));
  }
  static void numeric() {
    int overflow = Integer.MAX_VALUE + 1;
    long longOverflow = Long.MAX_VALUE + 1L;
    byte narrowed = (byte) 255;
    byte small = 127;
    int promoted = small + 3;
    char letter = (char) ('А' + 1);
    System.out.print(overflow + ":" + longOverflow + ":" + narrowed + ":" + promoted + ":" + letter + ":" + (int) -3.9 + ":");
    Integer missing = null;
    try {
      int unboxed = missing;
      System.out.print(unboxed);
    } catch (NullPointerException expected) {
      System.out.println("NPE");
    }
  }
  static void arrays() {
    int[][] values = new int[][]{{1, 2}, {3}};
    int[] alias = values[0];
    alias[1] = 9;
    int[] empty = new int[0];
    int total = values[0][1] + values[1][0];
    System.out.print(total + ":" + values.length + ":" + values[1].length + ":" + empty.length + ":");
    try {
      System.out.print(values[1][1]);
    } catch (ArrayIndexOutOfBoundsException expected) {
      System.out.print("B");
    }
    int[] missing = null;
    try {
      System.out.print(missing.length);
    } catch (NullPointerException expected) {
      System.out.println("N");
    }
  }
  static boolean tick() { effects++; System.out.print("T"); return true; }
  static void conditions(boolean first) {
    effects = 0;
    boolean and = first && tick();
    boolean or = first || tick();
    int chosen = first ? effects++ : ++effects;
    System.out.println("|" + and + ":" + or + ":" + chosen + ":" + effects);
  }
  static void strings() {
    String value = "Привет";
    int number = Integer.parseInt("12") + Math.abs(-3);
    String built = new StringBuilder(value).append(':').append(number).toString();
    System.out.println(built + ":" + value.length() + ":" + value.startsWith("При") + ":" + (int) Character.valueOf('A'));
  }
  static void console(String mode) {
    Scanner scanner = new Scanner(System.in, StandardCharsets.UTF_8);
    if (mode.equals("invalid")) {
      try {
        scanner.nextInt();
      } catch (InputMismatchException expected) {
        System.out.println("MISMATCH");
      }
      return;
    }
    if (!scanner.hasNextInt()) { System.out.println("EOF"); return; }
    int first = scanner.nextInt() + 0;
    int second = scanner.nextInt();
    int third = scanner.nextInt();
    scanner.nextLine();
    String line = scanner.nextLine();
    System.out.println(first + ":" + second + ":" + third + ":" + line + ":" + scanner.hasNext());
  }
  static void formatting() {
    StringBuilder buffer = new StringBuilder();
    Formatter formatter = new Formatter(buffer, Locale.ROOT);
    formatter.format("%s %d %.2f%n", "Привет", 7, 1.25);
    System.out.print(buffer.toString());
    System.out.printf(Locale.ROOT, "%s:%04d:%.1f%n", "Я", 3, 2.5);
  }
  static void collections() {
    List<String> list = new ArrayList<>(Arrays.asList("a", null, "a", "b"));
    Iterator<String> iterator = list.iterator();
    while (iterator.hasNext()) {
      String value = iterator.next();
      if (value == null) iterator.remove();
    }
    Map<String, Integer> map = new LinkedHashMap<>();
    map.put("x", 1);
    map.put("y", 2);
    map.put("x", 3);
    Set<String> set = new LinkedHashSet<>(list);
    System.out.print(list + ":" + map + ":" + set + ":");
    List<String> invalid = new ArrayList<>(Arrays.asList("x", "y"));
    Iterator<String> stale = invalid.iterator();
    invalid.add("z");
    try {
      stale.next();
    } catch (ConcurrentModificationException expected) {
      System.out.println("C");
    }
  }
  static void comparator() {
    List<Item> items = new ArrayList<>();
    items.add(new Item(2, "b", "B"));
    items.add(new Item(1, "z", "Z"));
    items.add(new Item(2, "a", "first"));
    items.add(new Item(2, "a", "second"));
    items.sort(new NamedComparator());
    for (Item item : items) System.out.print(item.key + item.name + ":" + item.tag + ",");
    System.out.println();
  }
  static String fallback() { effects++; return "F"; }
  static void optional(String mode) {
    effects = 0;
    Optional<String> optional = Optional.ofNullable(mode.equals("empty") ? null : "V");
    String result = optional.orElse(fallback());
    System.out.println(result + ":" + effects + ":" + optional.isPresent());
  }
  static void raising(int mode) throws Checked {
    System.out.print("T");
    if (mode == 0) throw new Checked("checked");
    if (mode == 1) throw new IllegalArgumentException("unchecked");
    System.out.print("N");
  }
  static void exceptions(int mode) {
    try {
      raising(mode);
    } catch (Checked expected) {
      System.out.print("C");
    } catch (RuntimeException expected) {
      System.out.print("U");
    } finally {
      System.out.print("F");
    }
    System.out.println();
  }
}
interface Contract { int value(int x); }
class Base implements Contract {
  static { System.out.print("B"); }
  { System.out.print("b"); }
  Base() { System.out.print("C"); }
  public int value(int x) { return x; }
  int value(Integer x) { return x + 10; }
}
class Child extends Base {
  static int count = 4;
  static { System.out.print("S"); }
  { System.out.print("s"); }
  Child() { super(); System.out.print("D"); }
  @Override public int value(int x) { return x * 2; }
}
class Item {
  final int key;
  final String name;
  final String tag;
  Item(int key, String name, String tag) { this.key = key; this.name = name; this.tag = tag; }
}
class NamedComparator implements Comparator<Item> {
  public int compare(Item left, Item right) {
    int primary = Integer.compare(left.key, right.key);
    if (primary != 0) return -primary;
    return left.name.compareTo(right.name);
  }
}
class Checked extends Exception { Checked(String message) { super(message); } }
