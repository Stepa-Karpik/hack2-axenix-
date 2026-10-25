import java.nio.charset.StandardCharsets;
import java.util.*;

public class Main {
  static int effects;
  public static void main(String[] args) throws Exception {
    String mode = args.length > 1 ? args[1] : "";
    switch (args[0]) {
      case "initializers": initializerOrder(); break;
      case "loops": loopCases(); break;
      case "anonymous-comparator": anonymousComparator(); break;
      case "algorithms": AlgorithmCases.run(); break;
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
  static void initializerOrder() {
    InitOrder first = new InitOrder(1);
    InitOrder second = new InitOrder(2);
    System.out.println(InitLog.trace.toString());
    System.out.println(first.x + second.y + ":" + InitConstants.VALUE);
  }
  static void loopCases() {
    int forSum = 0;
    for (int i = 0; i < 5; i++) {
      if (i == 2) continue;
      forSum += i;
    }
    int whileCount = 0;
    while (whileCount < 3) whileCount++;
    int doCount = 0;
    do { doCount++; } while (false);
    int enhanced = 0;
    for (int value : new int[]{2, 3, 4}) enhanced += value;
    int nested = 0;
    for (int i = 0; i < 3; i++) {
      for (int j = 0; j < 4; j++) {
        if (j == 1) continue;
        if (j == 3) break;
        nested += i + j;
      }
    }
    int switched = 0;
    switch (2) {
      case 1: switched += 1;
      case 2:
        switch (1) {
          case 1: switched += 10; break;
          default: switched += 100;
        }
      default: switched += 3;
    }
    System.out.println(forSum + ":" + whileCount + ":" + doCount + ":" + enhanced + ":" + nested + ":" + switched);
  }
  static void anonymousComparator() {
    List<Item> items = new ArrayList<>();
    items.add(new Item(2, "b", "B"));
    items.add(new Item(1, "z", "Z"));
    items.add(new Item(2, "a", "first"));
    items.add(new Item(2, "a", "second"));
    items.sort(new Comparator<Item>() {
      public int compare(Item left, Item right) {
        int primary = Integer.compare(left.key, right.key);
        if (primary != 0) return -primary;
        return left.name.compareTo(right.name);
      }
    });
    for (Item item : items) System.out.print(item.key + item.name + ":" + item.tag + ",");
    System.out.println();
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
class InitLog {
  static StringBuilder trace = new StringBuilder();
  static int mark(String value) {
    trace.append(value).append(';');
    return 1;
  }
}
interface InitConstants {
  int VALUE = 7;
}
class InitParent {
  static int parent = InitLog.mark("PS");
  { InitLog.mark("PI"); }
  InitParent() { InitLog.mark("PC"); }
}
class InitOrder extends InitParent {
  static int a = InitLog.mark("S1");
  static { InitLog.mark("SB"); }
  static int b = InitLog.mark("S2");
  int x = InitLog.mark("I1");
  { InitLog.mark("IB"); }
  int y = InitLog.mark("I2");
  InitOrder() {
    super();
    InitLog.mark("C0");
  }
  InitOrder(int ignored) {
    this();
    InitLog.mark("C1");
  }
}

/** Bounded, deterministic algorithm workload. Every implementation has independent fixed edge assertions. */
class AlgorithmCases {
  static int checks;

  static void run() {
    verifyLinearSearch();
    verifyBinarySearch();
    verifyLowerBound();
    verifyUpperBound();
    verifyGcd();
    verifyLcm();
    verifyFibonacci();
    verifyFactorial();
    verifyPrime();
    verifySieve();
    verifyDigitSum();
    verifyReverseDigits();
    verifyPalindrome();
    verifyRotation();
    verifyPrefixSums();
    verifyWindow();
    verifyTwoSum();
    verifyDeduplication();
    verifyMerge();
    verifyInsertionSort();
    verifySelectionSort();
    verifyBubbleSort();
    verifyReverseText();
    verifyWords();
    verifyFrequencies();
    verifyBrackets();
    verifyTranspose();
    verifyMatrixProduct();
    verifyFloodFill();
    verifyEditDistance();
    verifyLongestIncreasing();
    verifyCoinChange();
    verifyMaximumSubarray();
    verifyBits();
    verifyPolynomial();
    verifyPermutation();
    System.out.println("algorithms:" + checks);
  }

  static void require(boolean condition) {
    if (!condition) {
      throw new AssertionError("algorithm check " + checks);
    }
    checks++;
  }

  static int linearSearch(int[] values, int wanted) {
    for (int i = 0; i < values.length; i++) {
      if (values[i] == wanted) {
        return i;
      }
    }
    return -1;
  }

  static void verifyLinearSearch() {
    int[] values = new int[]{4, 2, 9, 2};
    require(linearSearch(values, 2) == 1);
    require(linearSearch(values, 9) == 2);
    require(linearSearch(values, 7) == -1);
    require(linearSearch(new int[0], 0) == -1);
  }

  static int binarySearch(int[] values, int wanted) {
    int low = 0;
    int high = values.length - 1;
    while (low <= high) {
      int middle = low + (high - low) / 2;
      if (values[middle] == wanted) {
        return middle;
      }
      if (values[middle] < wanted) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return -1;
  }

  static void verifyBinarySearch() {
    int[] values = new int[]{1, 3, 5, 9, 12};
    require(binarySearch(values, 9) == 3);
    require(binarySearch(values, 1) == 0);
    require(binarySearch(values, 12) == 4);
    require(binarySearch(new int[0], 9) == -1);
  }

  static int lowerBound(int[] values, int wanted) {
    int low = 0;
    int high = values.length;
    while (low < high) {
      int middle = low + (high - low) / 2;
      if (values[middle] < wanted) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  static void verifyLowerBound() {
    int[] values = new int[]{1, 2, 2, 5};
    require(lowerBound(values, 2) == 1);
    require(lowerBound(values, 0) == 0);
    require(lowerBound(values, 9) == 4);
    require(lowerBound(new int[0], 4) == 0);
  }

  static int upperBound(int[] values, int wanted) {
    int low = 0;
    int high = values.length;
    while (low < high) {
      int middle = low + (high - low) / 2;
      if (values[middle] <= wanted) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  static void verifyUpperBound() {
    int[] values = new int[]{1, 2, 2, 5};
    require(upperBound(values, 2) == 3);
    require(upperBound(values, 0) == 0);
    require(upperBound(values, 9) == 4);
    require(upperBound(new int[0], 4) == 0);
  }

  static int gcd(int left, int right) {
    left = Math.abs(left);
    right = Math.abs(right);
    while (right != 0) {
      int remainder = left % right;
      left = right;
      right = remainder;
    }
    return left;
  }

  static void verifyGcd() {
    require(gcd(54, 24) == 6);
    require(gcd(0, 7) == 7);
    require(gcd(-18, 12) == 6);
    require(gcd(0, 0) == 0);
  }

  static int lcm(int left, int right) {
    if (left == 0 || right == 0) {
      return 0;
    }
    int divisor = gcd(left, right);
    int reduced = left / divisor;
    return Math.abs(reduced * right);
  }

  static void verifyLcm() {
    require(lcm(6, 8) == 24);
    require(lcm(7, 5) == 35);
    require(lcm(0, 5) == 0);
    require(lcm(-4, 6) == 12);
  }

  static int fibonacci(int index) {
    int previous = 0;
    int current = 1;
    for (int i = 0; i < index; i++) {
      int next = previous + current;
      previous = current;
      current = next;
    }
    return previous;
  }

  static void verifyFibonacci() {
    require(fibonacci(0) == 0);
    require(fibonacci(1) == 1);
    require(fibonacci(2) == 1);
    require(fibonacci(10) == 55);
  }

  static long factorial(int number) {
    if (number < 0) {
      throw new IllegalArgumentException("negative factorial");
    }
    long result = 1L;
    for (int factor = 2; factor <= number; factor++) {
      result *= factor;
    }
    return result;
  }

  static void verifyFactorial() {
    require(factorial(0) == 1L);
    require(factorial(1) == 1L);
    require(factorial(6) == 720L);
    require(factorial(10) == 3628800L);
  }

  static boolean prime(int value) {
    if (value < 2) {
      return false;
    }
    for (int divisor = 2; divisor <= value / divisor; divisor++) {
      if (value % divisor == 0) {
        return false;
      }
    }
    return true;
  }

  static void verifyPrime() {
    require(!prime(0));
    require(!prime(1));
    require(prime(2));
    require(prime(29));
  }

  static int countPrimes(int limit) {
    boolean[] composite = new boolean[limit + 1];
    int count = 0;
    for (int value = 2; value <= limit; value++) {
      if (!composite[value]) {
        count++;
        for (int multiple = value * 2; multiple <= limit; multiple += value) {
          composite[multiple] = true;
        }
      }
    }
    return count;
  }

  static void verifySieve() {
    require(countPrimes(0) == 0);
    require(countPrimes(1) == 0);
    require(countPrimes(2) == 1);
    require(countPrimes(30) == 10);
  }

  static int digitSum(int value) {
    int result = 0;
    do {
      result += value % 10;
      value /= 10;
    } while (value != 0);
    return result;
  }

  static void verifyDigitSum() {
    require(digitSum(0) == 0);
    require(digitSum(7) == 7);
    require(digitSum(12345) == 15);
    require(digitSum(10010) == 2);
  }

  static int reverseDigits(int value) {
    int result = 0;
    while (value != 0) {
      int digit = value % 10;
      result = result * 10 + digit;
      value /= 10;
    }
    return result;
  }

  static void verifyReverseDigits() {
    require(reverseDigits(0) == 0);
    require(reverseDigits(7) == 7);
    require(reverseDigits(1203) == 3021);
    require(reverseDigits(-123) == -321);
  }

  static boolean palindrome(String text) {
    int left = 0;
    int right = text.length() - 1;
    while (left < right) {
      if (text.charAt(left) != text.charAt(right)) {
        return false;
      }
      left++;
      right--;
    }
    return true;
  }

  static void verifyPalindrome() {
    require(palindrome(""));
    require(palindrome("a"));
    require(palindrome("level"));
    require(!palindrome("lever"));
  }

  static int[] rotate(int[] values, int distance) {
    int[] result = new int[values.length];
    if (values.length == 0) {
      return result;
    }
    int normalized = Math.floorMod(distance, values.length);
    for (int i = 0; i < values.length; i++) {
      result[(i + normalized) % values.length] = values[i];
    }
    return result;
  }

  static void verifyRotation() {
    int[] values = new int[]{1, 2, 3, 4, 5};
    require(Arrays.equals(rotate(values, 2), new int[]{4, 5, 1, 2, 3}));
    require(Arrays.equals(rotate(values, 0), values));
    require(Arrays.equals(rotate(values, -1), new int[]{2, 3, 4, 5, 1}));
    require(rotate(new int[0], 2).length == 0);
  }

  static int[] prefixSums(int[] values) {
    int[] result = new int[values.length];
    int total = 0;
    for (int i = 0; i < values.length; i++) {
      total += values[i];
      result[i] = total;
    }
    return result;
  }

  static void verifyPrefixSums() {
    require(prefixSums(new int[0]).length == 0);
    require(Arrays.equals(prefixSums(new int[]{2, -1, 3}), new int[]{2, 1, 4}));
    require(Arrays.equals(prefixSums(new int[]{0, 0}), new int[]{0, 0}));
    require(Arrays.equals(prefixSums(new int[]{-2, -3}), new int[]{-2, -5}));
  }

  static int maxWindow(int[] values, int width) {
    if (width < 1 || width > values.length) {
      throw new IllegalArgumentException("window width");
    }
    int total = 0;
    for (int i = 0; i < width; i++) total += values[i];
    int best = total;
    for (int i = width; i < values.length; i++) {
      total += values[i] - values[i - width];
      best = Math.max(best, total);
    }
    return best;
  }

  static void verifyWindow() {
    int[] values = new int[]{2, -1, 3, 4};
    require(maxWindow(values, 2) == 7);
    require(maxWindow(values, 4) == 8);
    require(maxWindow(values, 1) == 4);
    require(maxWindow(new int[]{-4, -2, -3}, 2) == -5);
  }

  static boolean twoSum(int[] values, int target) {
    Set<Integer> seen = new HashSet<>();
    for (int value : values) {
      int complement = target - value;
      if (seen.contains(complement)) {
        return true;
      }
      seen.add(value);
    }
    return false;
  }

  static void verifyTwoSum() {
    require(twoSum(new int[]{2, 7, 11, 15}, 9));
    require(twoSum(new int[]{3, 3}, 6));
    require(!twoSum(new int[]{3}, 6));
    require(!twoSum(new int[0], 0));
  }

  static int deduplicate(int[] values) {
    if (values.length == 0) {
      return 0;
    }
    int write = 1;
    for (int read = 1; read < values.length; read++) {
      if (values[read] != values[write - 1]) {
        values[write++] = values[read];
      }
    }
    return write;
  }

  static void verifyDeduplication() {
    int[] values = new int[]{1, 1, 2, 2, 3};
    require(deduplicate(values) == 3);
    require(values[0] == 1 && values[1] == 2 && values[2] == 3);
    require(deduplicate(new int[0]) == 0);
    require(deduplicate(new int[]{7, 7, 7}) == 1);
  }

  static int[] merge(int[] left, int[] right) {
    int[] result = new int[left.length + right.length];
    int i = 0;
    int j = 0;
    int write = 0;
    while (i < left.length && j < right.length) {
      if (left[i] <= right[j]) {
        result[write++] = left[i++];
      } else {
        result[write++] = right[j++];
      }
    }
    while (i < left.length) result[write++] = left[i++];
    while (j < right.length) result[write++] = right[j++];
    return result;
  }

  static void verifyMerge() {
    require(Arrays.equals(merge(new int[]{1, 3, 5}, new int[]{2, 4, 6}), new int[]{1, 2, 3, 4, 5, 6}));
    require(Arrays.equals(merge(new int[0], new int[]{2}), new int[]{2}));
    require(Arrays.equals(merge(new int[]{2}, new int[0]), new int[]{2}));
    require(merge(new int[0], new int[0]).length == 0);
  }

  static void insertionSort(int[] values) {
    for (int i = 1; i < values.length; i++) {
      int value = values[i];
      int place = i;
      while (place > 0 && values[place - 1] > value) {
        values[place] = values[place - 1];
        place--;
      }
      values[place] = value;
    }
  }

  static void verifyInsertionSort() {
    int[] values = new int[]{4, 1, 3, 2};
    insertionSort(values);
    require(Arrays.equals(values, new int[]{1, 2, 3, 4}));
    int[] duplicates = new int[]{2, 1, 2};
    insertionSort(duplicates);
    require(Arrays.equals(duplicates, new int[]{1, 2, 2}));
    insertionSort(new int[0]);
  }

  static void selectionSort(int[] values) {
    for (int i = 0; i < values.length; i++) {
      int selected = i;
      for (int j = i + 1; j < values.length; j++) {
        if (values[j] < values[selected]) selected = j;
      }
      int swap = values[i];
      values[i] = values[selected];
      values[selected] = swap;
    }
  }

  static void verifySelectionSort() {
    int[] values = new int[]{4, 1, 3, 2};
    selectionSort(values);
    require(Arrays.equals(values, new int[]{1, 2, 3, 4}));
    int[] negatives = new int[]{-1, -3, -2};
    selectionSort(negatives);
    require(Arrays.equals(negatives, new int[]{-3, -2, -1}));
    selectionSort(new int[0]);
  }

  static void bubbleSort(int[] values) {
    for (int end = values.length - 1; end > 0; end--) {
      boolean changed = false;
      for (int i = 0; i < end; i++) {
        if (values[i] > values[i + 1]) {
          int swap = values[i];
          values[i] = values[i + 1];
          values[i + 1] = swap;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  static void verifyBubbleSort() {
    int[] values = new int[]{4, 1, 3, 2};
    bubbleSort(values);
    require(Arrays.equals(values, new int[]{1, 2, 3, 4}));
    bubbleSort(values);
    require(Arrays.equals(values, new int[]{1, 2, 3, 4}));
    bubbleSort(new int[0]);
  }

  static String reverseText(String text) {
    StringBuilder result = new StringBuilder();
    for (int i = text.length() - 1; i >= 0; i--) {
      result.append(text.charAt(i));
    }
    return result.toString();
  }

  static void verifyReverseText() {
    require(reverseText("").equals(""));
    require(reverseText("a").equals("a"));
    require(reverseText("abc").equals("cba"));
    require(reverseText("Привет").equals("тевирП"));
  }

  static int wordCount(String text) {
    boolean inWord = false;
    int result = 0;
    for (int i = 0; i < text.length(); i++) {
      if (Character.isWhitespace(text.charAt(i))) {
        inWord = false;
      } else if (!inWord) {
        result++;
        inWord = true;
      }
    }
    return result;
  }

  static void verifyWords() {
    require(wordCount("") == 0);
    require(wordCount("   ") == 0);
    require(wordCount("  one two  three ") == 3);
    require(wordCount("Привет\tмир\nЯ") == 3);
  }

  static Map<Character, Integer> frequencies(String text) {
    Map<Character, Integer> result = new LinkedHashMap<>();
    for (int i = 0; i < text.length(); i++) {
      char letter = text.charAt(i);
      Integer prior = result.get(letter);
      if (prior == null) {
        result.put(letter, 1);
      } else {
        result.put(letter, prior + 1);
      }
    }
    return result;
  }

  static void verifyFrequencies() {
    require(frequencies("").isEmpty());
    require(frequencies("banana").toString().equals("{b=1, a=3, n=2}"));
    require(frequencies("aaa").get('a') == 3);
    require(frequencies("абба").toString().equals("{а=2, б=2}"));
  }

  static boolean brackets(String text) {
    Deque<Character> stack = new ArrayDeque<>();
    for (int i = 0; i < text.length(); i++) {
      char current = text.charAt(i);
      if (current == '(' || current == '[' || current == '{') {
        stack.push(current);
      } else if (current == ')' || current == ']' || current == '}') {
        if (stack.isEmpty()) return false;
        char opening = stack.pop();
        if (current == ')' && opening != '(') return false;
        if (current == ']' && opening != '[') return false;
        if (current == '}' && opening != '{') return false;
      }
    }
    return stack.isEmpty();
  }

  static void verifyBrackets() {
    require(brackets(""));
    require(brackets("(a[b]{c})"));
    require(!brackets("([)]"));
    require(!brackets("("));
  }

  static int[][] transpose(int[][] matrix) {
    if (matrix.length == 0) {
      return new int[0][0];
    }
    int rows = matrix.length;
    int columns = matrix[0].length;
    int[][] result = new int[columns][rows];
    for (int row = 0; row < rows; row++) {
      for (int column = 0; column < columns; column++) {
        result[column][row] = matrix[row][column];
      }
    }
    return result;
  }

  static void verifyTranspose() {
    int[][] matrix = new int[][]{{1, 2, 3}, {4, 5, 6}};
    int[][] result = transpose(matrix);
    require(Arrays.deepEquals(result, new int[][]{{1, 4}, {2, 5}, {3, 6}}));
    require(Arrays.deepEquals(transpose(result), matrix));
    require(transpose(new int[0][0]).length == 0);
    require(Arrays.deepEquals(transpose(new int[][]{{7}}), new int[][]{{7}}));
  }

  static int[][] multiply(int[][] left, int[][] right) {
    int rows = left.length;
    int columns = right[0].length;
    int shared = right.length;
    int[][] result = new int[rows][columns];
    for (int row = 0; row < rows; row++) {
      for (int column = 0; column < columns; column++) {
        for (int index = 0; index < shared; index++) {
          result[row][column] += left[row][index] * right[index][column];
        }
      }
    }
    return result;
  }

  static void verifyMatrixProduct() {
    int[][] left = new int[][]{{1, 2}, {3, 4}};
    int[][] right = new int[][]{{2, 0}, {1, 2}};
    int[][] identity = new int[][]{{1, 0}, {0, 1}};
    require(Arrays.deepEquals(multiply(left, right), new int[][]{{4, 4}, {10, 8}}));
    require(Arrays.deepEquals(multiply(left, identity), left));
    require(Arrays.deepEquals(multiply(identity, left), left));
    require(multiply(new int[][]{{3}}, new int[][]{{4}})[0][0] == 12);
  }

  static int flood(int[][] grid, int row, int column) {
    if (row < 0 || column < 0 || row >= grid.length || column >= grid[row].length) {
      return 0;
    }
    if (grid[row][column] != 1) {
      return 0;
    }
    grid[row][column] = 2;
    int count = 1;
    count += flood(grid, row - 1, column);
    count += flood(grid, row + 1, column);
    count += flood(grid, row, column - 1);
    count += flood(grid, row, column + 1);
    return count;
  }

  static void verifyFloodFill() {
    int[][] grid = new int[][]{{1, 1, 0}, {0, 1, 0}, {1, 0, 1}};
    require(flood(grid, 0, 0) == 3);
    require(flood(grid, 0, 0) == 0);
    require(flood(grid, 2, 0) == 1);
    require(flood(new int[0][0], 0, 0) == 0);
  }

  static int editDistance(String left, String right) {
    int[][] costs = new int[left.length() + 1][right.length() + 1];
    for (int i = 0; i <= left.length(); i++) costs[i][0] = i;
    for (int j = 0; j <= right.length(); j++) costs[0][j] = j;
    for (int i = 1; i <= left.length(); i++) {
      for (int j = 1; j <= right.length(); j++) {
        int substitution = left.charAt(i - 1) == right.charAt(j - 1) ? 0 : 1;
        int replace = costs[i - 1][j - 1] + substitution;
        int insert = costs[i][j - 1] + 1;
        int delete = costs[i - 1][j] + 1;
        costs[i][j] = Math.min(replace, Math.min(insert, delete));
      }
    }
    return costs[left.length()][right.length()];
  }

  static void verifyEditDistance() {
    require(editDistance("", "") == 0);
    require(editDistance("", "abc") == 3);
    require(editDistance("kitten", "sitting") == 3);
    require(editDistance("abc", "abc") == 0);
  }

  static int longestIncreasing(int[] values) {
    int[] lengths = new int[values.length];
    int best = 0;
    for (int i = 0; i < values.length; i++) {
      lengths[i] = 1;
      for (int j = 0; j < i; j++) {
        if (values[j] < values[i]) {
          lengths[i] = Math.max(lengths[i], lengths[j] + 1);
        }
      }
      best = Math.max(best, lengths[i]);
    }
    return best;
  }

  static void verifyLongestIncreasing() {
    require(longestIncreasing(new int[0]) == 0);
    require(longestIncreasing(new int[]{7, 7, 7}) == 1);
    require(longestIncreasing(new int[]{3, 1, 2, 5, 4}) == 3);
    require(longestIncreasing(new int[]{1, 2, 3, 4}) == 4);
  }

  static int coinChange(int[] coins, int amount) {
    int[] counts = new int[amount + 1];
    Arrays.fill(counts, amount + 1);
    counts[0] = 0;
    for (int value = 1; value <= amount; value++) {
      for (int coin : coins) {
        if (coin <= value) {
          counts[value] = Math.min(counts[value], counts[value - coin] + 1);
        }
      }
    }
    return counts[amount] > amount ? -1 : counts[amount];
  }

  static void verifyCoinChange() {
    require(coinChange(new int[]{1, 3, 4}, 6) == 2);
    require(coinChange(new int[]{2}, 3) == -1);
    require(coinChange(new int[]{1, 2}, 0) == 0);
    require(coinChange(new int[]{5}, 10) == 2);
  }

  static int maximumSubarray(int[] values) {
    if (values.length == 0) {
      return 0;
    }
    int ending = values[0];
    int best = ending;
    for (int i = 1; i < values.length; i++) {
      ending = Math.max(values[i], ending + values[i]);
      best = Math.max(best, ending);
    }
    return best;
  }

  static void verifyMaximumSubarray() {
    require(maximumSubarray(new int[0]) == 0);
    require(maximumSubarray(new int[]{-3, -1, -2}) == -1);
    require(maximumSubarray(new int[]{-2, 1, -3, 4, -1, 2, 1, -5, 4}) == 6);
    require(maximumSubarray(new int[]{7}) == 7);
  }

  static int populationCount(int value) {
    int count = 0;
    while (value != 0) {
      value &= value - 1;
      count++;
    }
    return count;
  }

  static void verifyBits() {
    require(populationCount(0) == 0);
    require(populationCount(7) == 3);
    require(populationCount(Integer.MIN_VALUE) == 1);
    require(populationCount(-1) == 32);
  }

  static int polynomial(int[] coefficients, int x) {
    int result = 0;
    for (int coefficient : coefficients) {
      result = result * x + coefficient;
    }
    return result;
  }

  static void verifyPolynomial() {
    require(polynomial(new int[0], 7) == 0);
    require(polynomial(new int[]{2, 3, 4}, 2) == 18);
    require(polynomial(new int[]{2, 3, 4}, 0) == 4);
    require(polynomial(new int[]{1, 0, -1}, 3) == 8);
  }

  static boolean nextPermutation(int[] values) {
    int pivot = values.length - 2;
    while (pivot >= 0 && values[pivot] >= values[pivot + 1]) pivot--;
    if (pivot < 0) {
      return false;
    }
    int successor = values.length - 1;
    while (values[successor] <= values[pivot]) successor--;
    int swap = values[pivot];
    values[pivot] = values[successor];
    values[successor] = swap;
    int left = pivot + 1;
    int right = values.length - 1;
    while (left < right) {
      swap = values[left];
      values[left++] = values[right];
      values[right--] = swap;
    }
    return true;
  }

  static void verifyPermutation() {
    int[] values = new int[]{1, 2, 3};
    require(nextPermutation(values));
    require(Arrays.equals(values, new int[]{1, 3, 2}));
    require(!nextPermutation(new int[]{3, 2, 1}));
    require(!nextPermutation(new int[0]));
  }
}
