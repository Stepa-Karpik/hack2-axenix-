import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Scanner;
import java.util.TreeSet;

/**
 * Тестовая программа №2: числа, массивы и матрицы.
 */
public class NumberCruncherMess {

    static class InvalidMatrixException extends RuntimeException {
        public InvalidMatrixException(String message) {
            super(message);
        }
    }

    static class CalculationException extends Exception {
        public CalculationException(String message, Throwable cause) {
            super(message, cause);
        }

        public CalculationException(String message) {
            super(message);
        }
    }

    static long seed = 12345;
    static int callsFib = 0;
    static int callsDet = 0;
    static int callsPrime = 0;
    static int totalSteps = 0;

    // ------------------------------------------------------------------
    // Генератор данных (собственный линейный конгруэнтный)
    // ------------------------------------------------------------------

    static int nextRandom(int bound) {
        seed = (seed * 1103515245L + 12345L) % 2147483648L;
        int value = (int) (seed % bound);
        if (value < 0) {
            value = -value;
        }
        return value;
    }

    static int[] generateArray(int n, int bound) {
        int[] arr = new int[n];
        for (int i = 0; i < n; i++) {
            arr[i] = nextRandom(bound);
        }
        return arr;
    }

    static int[] copyArray(int[] src) {
        int[] dst = new int[src.length];
        for (int i = 0; i < src.length; i++) {
            dst[i] = src[i];
        }
        return dst;
    }

    static void printArray(String title, int[] arr, int limit) {
        String line = title + ": [";
        for (int i = 0; i < arr.length && i < limit; i++) {
            line = line + arr[i];
            if (i < arr.length - 1 && i < limit - 1) {
                line = line + ", ";
            }
        }
        if (arr.length > limit) {
            line = line + ", ...";
        }
        line = line + "]";
        System.out.println(line);
    }

    // ------------------------------------------------------------------
    // Простые числа
    // ------------------------------------------------------------------

    static boolean isPrimeNaive(int n) {
        callsPrime++;
        if (n < 2) {
            return false;
        }
        for (int i = 2; i < n; i++) {
            totalSteps++;
            if (n % i == 0) {
                return false;
            }
        }
        return true;
    }

    static List<Integer> primesUpTo(int limit) {
        List<Integer> primes = new ArrayList<>();
        for (int i = 2; i <= limit; i++) {
            if (isPrimeNaive(i)) {
                primes.add(i);
            }
        }
        return primes;
    }

    static int countTwinPrimes(int limit) {
        int count = 0;
        for (int i = 2; i + 2 <= limit; i++) {
            if (isPrimeNaive(i) && isPrimeNaive(i + 2)) {
                count++;
            }
        }
        return count;
    }

    static List<Integer> factorize(int n) {
        List<Integer> factors = new ArrayList<>();
        int rest = n;
        for (int candidate = 2; candidate <= n; candidate++) {
            while (rest % candidate == 0 && isPrimeNaive(candidate)) {
                factors.add(candidate);
                rest = rest / candidate;
            }
        }
        return factors;
    }

    static int largestPrimeFactor(int n) {
        List<Integer> factors = factorize(n);
        int best = 1;
        for (int i = 0; i < factors.size(); i++) {
            if (factors.get(i) > best) {
                best = factors.get(i);
            }
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Фибоначчи, факториал, биномиальные коэффициенты
    // ------------------------------------------------------------------

    static long fibRecursive(int n) {
        callsFib++;
        if (n <= 1) {
            return n;
        }
        return fibRecursive(n - 1) + fibRecursive(n - 2);
    }

    static long factorial(int n) throws CalculationException {
        if (n < 0) {
            throw new CalculationException("Факториал отрицательного числа: " + n);
        }
        if (n > 20) {
            throw new CalculationException("Переполнение long для n = " + n);
        }
        if (n == 0) {
            return 1;
        }
        return n * factorial(n - 1);
    }

    static long binomial(int n, int k) {
        if (k == 0 || k == n) {
            return 1;
        }
        return binomial(n - 1, k - 1) + binomial(n - 1, k);
    }

    static void printPascal(int rows) {
        for (int i = 0; i < rows; i++) {
            String line = "";
            for (int j = 0; j <= i; j++) {
                line = line + binomial(i, j) + " ";
            }
            System.out.println(line);
        }
    }

    static long sumOfFibonacci(int count) {
        long sum = 0;
        for (int i = 0; i < count; i++) {
            sum = sum + fibRecursive(i);
        }
        return sum;
    }

    // ------------------------------------------------------------------
    // НОД, НОК
    // ------------------------------------------------------------------

    static int gcdSubtractive(int a, int b) {
        if (a <= 0 || b <= 0) {
            throw new IllegalArgumentException("Числа должны быть положительными");
        }
        while (a != b) {
            if (a > b) {
                a = a - b;
            } else {
                b = b - a;
            }
            totalSteps++;
        }
        return a;
    }

    static long lcm(int a, int b) {
        long result = 1;
        while (result % a != 0 || result % b != 0) {
            result++;
            totalSteps++;
        }
        return result;
    }

    static int gcdOfArray(int[] arr) {
        int result = arr[0];
        for (int i = 1; i < arr.length; i++) {
            result = gcdSubtractive(result, arr[i]);
        }
        return result;
    }

    // ------------------------------------------------------------------
    // Сортировки
    // ------------------------------------------------------------------

    static void bubbleSort(int[] arr) {
        for (int i = 0; i < arr.length; i++) {
            for (int j = 0; j < arr.length - 1; j++) {
                if (arr[j] > arr[j + 1]) {
                    int t = arr[j];
                    arr[j] = arr[j + 1];
                    arr[j + 1] = t;
                }
                totalSteps++;
            }
        }
    }

    static void selectionSort(int[] arr) {
        for (int i = 0; i < arr.length; i++) {
            int minIndex = i;
            for (int j = i; j < arr.length; j++) {
                if (arr[j] < arr[minIndex]) {
                    minIndex = j;
                }
                totalSteps++;
            }
            int t = arr[i];
            arr[i] = arr[minIndex];
            arr[minIndex] = t;
        }
    }

    static void insertionSort(int[] arr) {
        for (int i = 1; i < arr.length; i++) {
            int key = arr[i];
            int j = i - 1;
            while (j >= 0 && arr[j] > key) {
                arr[j + 1] = arr[j];
                j--;
                totalSteps++;
            }
            arr[j + 1] = key;
        }
    }

    static boolean isSorted(int[] arr) {
        for (int i = 0; i < arr.length; i++) {
            for (int j = i + 1; j < arr.length; j++) {
                if (arr[i] > arr[j]) {
                    return false;
                }
            }
        }
        return true;
    }

    static boolean sameContents(int[] a, int[] b) {
        if (a.length != b.length) {
            return false;
        }
        for (int i = 0; i < a.length; i++) {
            int countA = 0;
            int countB = 0;
            for (int j = 0; j < a.length; j++) {
                if (a[j] == a[i]) {
                    countA++;
                }
                if (b[j] == a[i]) {
                    countB++;
                }
            }
            if (countA != countB) {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Поиск и статистика
    // ------------------------------------------------------------------

    static int linearSearch(int[] arr, int target) {
        for (int i = 0; i < arr.length; i++) {
            if (arr[i] == target) {
                return i;
            }
        }
        return -1;
    }

    static int countFound(int[] arr, int[] queries) {
        int found = 0;
        for (int i = 0; i < queries.length; i++) {
            if (linearSearch(arr, queries[i]) != -1) {
                found++;
            }
        }
        return found;
    }

    static int countDuplicatesNested(int[] arr) {
        int duplicates = 0;
        for (int i = 0; i < arr.length; i++) {
            boolean seenBefore = false;
            for (int j = 0; j < i; j++) {
                if (arr[j] == arr[i]) {
                    seenBefore = true;
                }
            }
            if (seenBefore) {
                duplicates++;
            }
        }
        return duplicates;
    }

    static List<Integer> findMissing(int[] arr, int maxValue) {
        List<Integer> missing = new ArrayList<>();
        for (int v = 0; v < maxValue; v++) {
            boolean present = false;
            for (int i = 0; i < arr.length; i++) {
                if (arr[i] == v) {
                    present = true;
                }
            }
            if (!present) {
                missing.add(v);
            }
        }
        return missing;
    }

    static int maxOf(int[] arr) {
        int max = arr[0];
        for (int i = 0; i < arr.length; i++) {
            int candidate = arr[i];
            for (int j = 0; j < arr.length; j++) {
                if (arr[j] > candidate) {
                    candidate = arr[j];
                }
            }
            if (candidate > max) {
                max = candidate;
            }
        }
        return max;
    }

    static double average(int[] arr) {
        long sum = 0;
        for (int i = 0; i < arr.length; i++) {
            sum = sum + arr[i];
        }
        return (double) sum / arr.length;
    }

    static int median(int[] arr) {
        int[] copy = copyArray(arr);
        bubbleSort(copy);
        return copy[copy.length / 2];
    }

    static int mostFrequent(int[] arr) {
        int bestValue = arr[0];
        int bestCount = 0;
        for (int i = 0; i < arr.length; i++) {
            int count = 0;
            for (int j = 0; j < arr.length; j++) {
                if (arr[j] == arr[i]) {
                    count++;
                }
            }
            if (count > bestCount || (count == bestCount && arr[i] < bestValue)) {
                bestCount = count;
                bestValue = arr[i];
            }
        }
        return bestValue;
    }

    // ------------------------------------------------------------------
    // Подмассивы и суммы
    // ------------------------------------------------------------------

    static long rangeSum(int[] arr, int from, int to) {
        long sum = 0;
        for (int i = from; i <= to; i++) {
            sum = sum + arr[i];
        }
        return sum;
    }

    static long sumOfAllRanges(int[] arr) {
        long total = 0;
        for (int i = 0; i < arr.length; i++) {
            for (int j = i; j < arr.length; j++) {
                total = total + rangeSum(arr, i, j);
            }
        }
        return total;
    }

    static long maxSubarrayBruteForce(int[] arr) {
        long best = Long.MIN_VALUE;
        for (int i = 0; i < arr.length; i++) {
            for (int j = i; j < arr.length; j++) {
                long sum = 0;
                for (int k = i; k <= j; k++) {
                    sum = sum + (arr[k] - 50);
                    totalSteps++;
                }
                if (sum > best) {
                    best = sum;
                }
            }
        }
        return best;
    }

    static int countPairsWithSum(int[] arr, int target) {
        int count = 0;
        for (int i = 0; i < arr.length; i++) {
            for (int j = 0; j < arr.length; j++) {
                if (i < j && arr[i] + arr[j] == target) {
                    count++;
                }
            }
        }
        return count;
    }

    static int countTriplesWithSum(int[] arr, int target) {
        int count = 0;
        for (int i = 0; i < arr.length; i++) {
            for (int j = i + 1; j < arr.length; j++) {
                for (int k = j + 1; k < arr.length; k++) {
                    if (arr[i] + arr[j] + arr[k] == target) {
                        count++;
                    }
                }
            }
        }
        return count;
    }

    // ------------------------------------------------------------------
    // Матрицы
    // ------------------------------------------------------------------

    static long[][] createMatrix(int rows, int cols, int bound) {
        long[][] m = new long[rows][cols];
        for (int i = 0; i < rows; i++) {
            for (int j = 0; j < cols; j++) {
                m[i][j] = nextRandom(bound);
            }
        }
        return m;
    }

    static long[][] multiply(long[][] a, long[][] b) {
        if (a[0].length != b.length) {
            throw new InvalidMatrixException("Размеры не согласованы: " + a[0].length + " и " + b.length);
        }
        long[][] c = new long[a.length][b[0].length];
        for (int i = 0; i < a.length; i++) {
            for (int j = 0; j < b[0].length; j++) {
                long sum = 0;
                for (int k = 0; k < a[0].length; k++) {
                    sum = sum + a[i][k] * b[k][j];
                    totalSteps++;
                }
                c[i][j] = sum % 1000007;
            }
        }
        return c;
    }

    static long[][] transpose(long[][] m) {
        long[][] t = new long[m[0].length][m.length];
        for (int i = 0; i < m.length; i++) {
            for (int j = 0; j < m[0].length; j++) {
                t[j][i] = m[i][j];
            }
        }
        return t;
    }

    static long[][] identity(int n) {
        long[][] m = new long[n][n];
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                if (i == j) {
                    m[i][j] = 1;
                } else {
                    m[i][j] = 0;
                }
            }
        }
        return m;
    }

    static long[][] power(long[][] m, int exp) {
        long[][] result = identity(m.length);
        for (int i = 0; i < exp; i++) {
            result = multiply(result, m);
        }
        return result;
    }

    static long[][] minor(long[][] m, int row, int col) {
        int n = m.length;
        long[][] result = new long[n - 1][n - 1];
        int ri = 0;
        for (int i = 0; i < n; i++) {
            if (i == row) {
                continue;
            }
            int rj = 0;
            for (int j = 0; j < n; j++) {
                if (j == col) {
                    continue;
                }
                result[ri][rj] = m[i][j];
                rj++;
            }
            ri++;
        }
        return result;
    }

    static long determinant(long[][] m) {
        callsDet++;
        if (m.length != m[0].length) {
            throw new InvalidMatrixException("Матрица не квадратная");
        }
        if (m.length == 1) {
            return m[0][0];
        }
        if (m.length == 2) {
            return m[0][0] * m[1][1] - m[0][1] * m[1][0];
        }
        long det = 0;
        for (int col = 0; col < m.length; col++) {
            long sign = 1;
            if (col % 2 == 1) {
                sign = -1;
            }
            det = det + sign * m[0][col] * determinant(minor(m, 0, col));
        }
        return det;
    }

    static long traceOf(long[][] m) {
        long sum = 0;
        for (int i = 0; i < m.length; i++) {
            for (int j = 0; j < m.length; j++) {
                if (i == j) {
                    sum = sum + m[i][j];
                }
            }
        }
        return sum;
    }

    static boolean isSymmetric(long[][] m) {
        long[][] t = transpose(m);
        for (int i = 0; i < m.length; i++) {
            for (int j = 0; j < m[0].length; j++) {
                if (m[i][j] != t[i][j]) {
                    return false;
                }
            }
        }
        return true;
    }

    static void printMatrix(String title, long[][] m) {
        System.out.println(title + ":");
        for (int i = 0; i < m.length; i++) {
            String line = "  ";
            for (int j = 0; j < m[i].length; j++) {
                line = line + m[i][j] + "\t";
            }
            System.out.println(line);
        }
    }

    // ------------------------------------------------------------------
    // Теория чисел: цифры, системы счисления
    // ------------------------------------------------------------------

    static int digitSum(int n) {
        String s = "" + n;
        int sum = 0;
        for (int i = 0; i < s.length(); i++) {
            sum = sum + Integer.parseInt("" + s.charAt(i));
        }
        return sum;
    }

    static boolean isPalindromeNumber(int n) {
        String s = "" + n;
        String reversed = "";
        for (int i = s.length() - 1; i >= 0; i--) {
            reversed = reversed + s.charAt(i);
        }
        return s.equals(reversed);
    }

    static boolean isArmstrong(int n) {
        String s = "" + n;
        int sum = 0;
        for (int i = 0; i < s.length(); i++) {
            int d = Integer.parseInt("" + s.charAt(i));
            int p = 1;
            for (int k = 0; k < s.length(); k++) {
                p = p * d;
            }
            sum = sum + p;
        }
        return sum == n;
    }

    static boolean isPerfect(int n) {
        int sum = 0;
        for (int i = 1; i < n; i++) {
            if (n % i == 0) {
                sum = sum + i;
            }
        }
        return n > 1 && sum == n;
    }

    static String toBinary(int n) {
        if (n == 0) {
            return "0";
        }
        String result = "";
        int rest = n;
        while (rest > 0) {
            result = (rest % 2) + result;
            rest = rest / 2;
        }
        return result;
    }

    static int fromBinary(String s) {
        int result = 0;
        for (int i = 0; i < s.length(); i++) {
            result = result * 2;
            if (s.charAt(i) == '1') {
                result = result + 1;
            } else if (s.charAt(i) != '0') {
                throw new NumberFormatException("Не двоичная цифра: " + s.charAt(i));
            }
        }
        return result;
    }

    static int countBits(int n) {
        String bin = toBinary(n);
        int count = 0;
        for (int i = 0; i < bin.length(); i++) {
            if (bin.charAt(i) == '1') {
                count++;
            }
        }
        return count;
    }

    static int countBitsShift(int n) {
        int count = 0;
        int x = n;
        while (x != 0) {
            count = count + (x & 1);
            x = x >>> 1;
        }
        return count;
    }

    static String toRoman(int n) {
        int[] values = {1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1};
        String[] symbols = {"M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"};
        String result = "";
        int rest = n;
        for (int i = 0; i < values.length; i++) {
            while (rest >= values[i]) {
                result = result + symbols[i];
                rest = rest - values[i];
            }
        }
        return result;
    }

    static int collatzLength(long start) {
        int length = 1;
        long n = start;
        while (n != 1) {
            if (n % 2 == 0) {
                n = n / 2;
            } else {
                n = 3 * n + 1;
            }
            length++;
        }
        return length;
    }

    static int longestCollatzUnder(int limit) {
        int bestStart = 1;
        int bestLength = 1;
        for (int i = 1; i < limit; i++) {
            int len = collatzLength(i);
            if (len > bestLength) {
                bestLength = len;
                bestStart = i;
            }
        }
        return bestStart;
    }

    // ------------------------------------------------------------------
    // Типы данных и приведения
    // ------------------------------------------------------------------

    static void typeDemo() {
        byte b = (byte) 200;
        short s = (short) 70000;
        int i = (int) 3000000000L;
        long l = Integer.MAX_VALUE + 1L;
        float f = 1.1f;
        double d = f;
        char c = (char) 66;
        boolean flag = (b < 0) && (s > 0);
        System.out.println("byte=" + b + " short=" + s + " int=" + i + " long=" + l);
        System.out.println("float=" + f + " double>float: " + (d > f) + " char=" + c + " flag=" + flag);
        System.out.println("7/2=" + (7 / 2) + " 7%2=" + (7 % 2) + " -7/2=" + (-7 / 2) + " -7%2=" + (-7 % 2));
        System.out.println("7/2.0=" + (7 / 2.0) + " (int)3.99=" + (int) 3.99 + " 1<<10=" + (1 << 10));
        Integer boxedA = 127;
        Integer boxedB = 127;
        System.out.println("boxed equals: " + boxedA.equals(boxedB));
        Object o = boxedA;
        if (o instanceof Integer) {
            System.out.println("o instanceof Integer, value+1=" + ((Integer) o + 1));
        }
        String label = (i < 0) ? "отрицательное" : "неотрицательное";
        System.out.println("int после приведения: " + label);
    }

    static String classify(int n) {
        switch (n % 5) {
            case 0:
                return "кратно пяти";
            case 1:
                return "остаток один";
            case 2:
            case 3:
                return "остаток два или три";
            default:
                return "остаток четыре";
        }
    }

    // ------------------------------------------------------------------
    // Коллекции для итогов
    // ------------------------------------------------------------------

    static Map<String, Integer> classifyAll(int[] arr) {
        Map<String, Integer> result = new HashMap<>();
        for (int i = 0; i < arr.length; i++) {
            String key = classify(arr[i]);
            if (result.containsKey(key)) {
                result.put(key, result.get(key) + 1);
            } else {
                result.put(key, 1);
            }
        }
        return result;
    }

    static TreeSet<Integer> sortedUniqueSet(int[] arr) {
        TreeSet<Integer> set = new TreeSet<>();
        for (int i = 0; i < arr.length; i++) {
            set.add(arr[i]);
        }
        return set;
    }

    static LinkedList<Integer> reverseViaLinkedList(int[] arr) {
        LinkedList<Integer> list = new LinkedList<>();
        for (int i = 0; i < arr.length; i++) {
            list.add(0, arr[i]);
        }
        return list;
    }

    static int sumLinkedListByIndex(LinkedList<Integer> list) {
        int sum = 0;
        for (int i = 0; i < list.size(); i++) {
            sum = sum + list.get(i);
        }
        return sum;
    }

    // ------------------------------------------------------------------
    // Ввод и вывод
    // ------------------------------------------------------------------

    static int readSize(Scanner scanner) {
        System.out.print("Размер массива (10..400, по умолчанию 200): ");
        if (scanner.hasNextInt()) {
            int n = scanner.nextInt();
            if (n >= 10 && n <= 400) {
                return n;
            }
            System.out.println("Значение вне диапазона, используем 200");
        }
        return 200;
    }

    static void section(String title) {
        System.out.println();
        System.out.println("##### " + title + " #####");
    }

    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        int n = readSize(scanner);
        int[] data = generateArray(n, 100);
        printArray("Исходные данные", data, 12);

        section("Простые числа");
        List<Integer> primes = primesUpTo(3000);
        System.out.println("Простых до 3000: " + primes.size());
        System.out.println("Близнецов до 1500: " + countTwinPrimes(1500));
        System.out.println("Разложение 360360: " + factorize(360360));
        System.out.println("Наибольший простой делитель 600851: " + largestPrimeFactor(600851));

        section("Фибоначчи и комбинаторика");
        System.out.println("fib(27) = " + fibRecursive(27) + ", вызовов: " + callsFib);
        System.out.println("Сумма первых 20 чисел Фибоначчи: " + sumOfFibonacci(20));
        printPascal(8);
        try {
            System.out.println("15! = " + factorial(15));
            System.out.println("25! = " + factorial(25));
        } catch (CalculationException e) {
            System.out.println("Ошибка вычисления: " + e.getMessage());
        }

        section("НОД и НОК");
        System.out.println("gcd(1071, 462) = " + gcdSubtractive(1071, 462));
        System.out.println("lcm(2520, 1155) = " + lcm(2520, 1155));
        int[] forGcd = {840, 1260, 2100, 5250};
        System.out.println("gcd массива = " + gcdOfArray(forGcd));
        try {
            gcdSubtractive(0, 5);
        } catch (IllegalArgumentException e) {
            System.out.println("Поймано: " + e.getMessage());
        }

        section("Сортировки");
        int[] a1 = copyArray(data);
        int[] a2 = copyArray(data);
        int[] a3 = copyArray(data);
        bubbleSort(a1);
        selectionSort(a2);
        insertionSort(a3);
        printArray("Пузырёк", a1, 12);
        System.out.println("Отсортирован: " + isSorted(a1) + " " + isSorted(a2) + " " + isSorted(a3));
        System.out.println("Одинаковое содержимое: " + sameContents(a1, a2) + " " + sameContents(a2, a3));
        System.out.println("Исходный отсортирован: " + isSorted(data));

        section("Поиск и статистика");
        int[] queries = generateArray(150, 150);
        System.out.println("Найдено запросов: " + countFound(data, queries));
        System.out.println("Дубликатов: " + countDuplicatesNested(data));
        System.out.println("Отсутствуют в 0..99: " + findMissing(data, 100).size() + " значений");
        System.out.println("Максимум: " + maxOf(data) + ", среднее: " + average(data));
        System.out.println("Медиана: " + median(data) + ", мода: " + mostFrequent(data));
        System.out.println("Уникальных (TreeSet): " + sortedUniqueSet(data).size());

        section("Подмассивы");
        int[] small = generateArray(60, 100);
        System.out.println("Сумма по всем отрезкам: " + sumOfAllRanges(small));
        System.out.println("Максимальный подмассив (смещённый): " + maxSubarrayBruteForce(small));
        System.out.println("Пар с суммой 100: " + countPairsWithSum(data, 100));
        System.out.println("Троек с суммой 150: " + countTriplesWithSum(small, 150));

        section("Матрицы");
        long[][] m1 = createMatrix(30, 30, 10);
        long[][] m2 = createMatrix(30, 30, 10);
        long[][] prod = multiply(m1, m2);
        System.out.println("След произведения: " + traceOf(prod));
        System.out.println("Симметрична: " + isSymmetric(prod));
        long[][] sq = createMatrix(3, 3, 9);
        printMatrix("Матрица 3x3", sq);
        printMatrix("Её куб", power(sq, 3));
        long[][] detM = createMatrix(7, 7, 5);
        System.out.println("Определитель 7x7: " + determinant(detM) + ", вызовов: " + callsDet);
        try {
            multiply(createMatrix(2, 3, 5), createMatrix(2, 3, 5));
        } catch (InvalidMatrixException e) {
            System.out.println("Поймано: " + e.getMessage());
        }

        section("Цифры и системы счисления");
        int armstrongCount = 0;
        int palindromeCount = 0;
        int perfectCount = 0;
        for (int i = 1; i < 10000; i++) {
            if (isArmstrong(i)) {
                armstrongCount++;
            }
            if (isPalindromeNumber(i)) {
                palindromeCount++;
            }
            if (isPerfect(i)) {
                perfectCount++;
            }
        }
        System.out.println("Армстронга: " + armstrongCount + ", палиндромов: " + palindromeCount + ", совершенных: " + perfectCount);
        System.out.println("Сумма цифр 98765: " + digitSum(98765));
        System.out.println("255 -> " + toBinary(255) + " -> " + fromBinary(toBinary(255)));
        System.out.println("Битов в 1023: " + countBits(1023) + " / " + countBitsShift(1023));
        System.out.println("1994 -> " + toRoman(1994));
        System.out.println("Самая длинная цепочка Коллатца до 30000: " + longestCollatzUnder(30000));
        try {
            fromBinary("10201");
        } catch (NumberFormatException e) {
            System.out.println("Поймано: " + e.getMessage());
        }

        section("Типы данных");
        typeDemo();
        Map<String, Integer> classes = classifyAll(data);
        System.out.println("Классы остатков: " + classes);
        LinkedList<Integer> reversed = reverseViaLinkedList(small);
        System.out.println("Сумма перевёрнутого списка: " + sumLinkedListByIndex(reversed));

        System.out.println();
        System.out.println("Всего шагов: " + totalSteps + ", проверок простоты: " + callsPrime);
        System.out.println("Готово");
    }
}
